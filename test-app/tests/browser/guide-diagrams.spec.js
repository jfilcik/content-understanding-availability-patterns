import { test, expect } from "@playwright/test";

const architectureUrl = new URL("../../../README.html", import.meta.url).href;
const walkthroughUrl = new URL("../../../single-apim-failover.html", import.meta.url).href;

async function expectClearRoutes(page, diagram, paths, nodes) {
  const geometry = await page.locator(diagram).evaluate((svg, selectors) => {
    const rectangles = [...svg.querySelectorAll(selectors.nodes)].map((rect) => ({
      x: rect.x.baseVal.value, y: rect.y.baseVal.value,
      width: rect.width.baseVal.value, height: rect.height.baseVal.value,
    }));
    const bounds = svg.viewBox.baseVal;
    const issues = [];
    const routes = [...svg.querySelectorAll(selectors.paths)].map((path) => {
      const length = path.getTotalLength();
      const count = Math.ceil(length / 2);
      const points = Array.from({ length: count + 1 }, (_, index) => {
        const point = path.getPointAtLength(length * index / count);
        return { x: point.x, y: point.y };
      });
      const id = path.dataset.edge || path.id;
      for (const point of points) {
        if (point.x < bounds.x || point.x > bounds.x + bounds.width ||
            point.y < bounds.y || point.y > bounds.y + bounds.height) {
          issues.push(`${id} leaves the diagram`);
          break;
        }
        if (rectangles.some((rect) =>
          point.x > rect.x - 4 && point.x < rect.x + rect.width + 4 &&
          point.y > rect.y - 4 && point.y < rect.y + rect.height + 4)) {
          issues.push(`${id} clips a node or its four-unit clearance`);
          break;
        }
      }
      for (const endpoint of [points[0], points.at(-1)]) {
        const distance = Math.min(...rectangles.map((rect) => Math.hypot(
          Math.max(rect.x - endpoint.x, 0, endpoint.x - rect.x - rect.width),
          Math.max(rect.y - endpoint.y, 0, endpoint.y - rect.y - rect.height),
        )));
        if (Math.abs(distance - 6) > 0.1) issues.push(`${id} does not end at a node port: ${distance}`);
      }
      for (const attribute of ["marker-start", "marker-end"]) {
        const marker = path.getAttribute(attribute);
        if (!marker || marker === "none") continue;
        const target = /^url\(#([^)]*)\)$/.exec(marker);
        if (!target || !svg.querySelector(`marker[id="${target[1]}"]`)) {
          issues.push(`${id} has a missing arrowhead`);
        }
      }
      if (!["marker-start", "marker-end"].some((attribute) => path.getAttribute(attribute)?.startsWith("url("))) {
        issues.push(`${id} has no directional arrowhead`);
      }
      return { id, points };
    });
    let minimumSeparation = Infinity;
    let closestRoutes = "";
    for (let first = 0; first < routes.length; first++) {
      for (let second = first + 1; second < routes.length; second++) {
        for (const a of routes[first].points) {
          for (const b of routes[second].points) {
            const separation = Math.hypot(a.x - b.x, a.y - b.y);
            if (separation < minimumSeparation) {
              minimumSeparation = separation;
              closestRoutes = `${routes[first].id} / ${routes[second].id}`;
            }
          }
        }
      }
    }
    return { issues, minimumSeparation, closestRoutes, count: routes.length };
  }, { paths, nodes });
  expect(geometry.count).toBeGreaterThan(0);
  expect(geometry.issues).toEqual([]);
  expect(geometry.minimumSeparation, geometry.closestRoutes).toBeGreaterThanOrEqual(8);
}

test("OFFLINE GUIDE: all stages and the regional outage have separated connectors, valid ports and arrowheads", async ({ page }) => {
  await page.goto(architectureUrl);
  for (let stage = 0; stage < 4; stage++) {
    await page.locator(`[data-stage="${stage}"]`).click();
    await expectClearRoutes(page, "#maturity-diagram", "#maturity-edges path", "#maturity-nodes rect");
    const next = page.locator("#job-next");
    while (await next.isEnabled()) {
      await next.click();
      await expectClearRoutes(page, "#maturity-diagram", "#maturity-edges path", "#maturity-nodes rect");
    }
  }
  await page.locator("#region-outage").click();
  await expectClearRoutes(page, "#maturity-diagram", "#maturity-edges path", "#maturity-nodes rect");
  await page.locator("#job-next").click();
  await expect(page.locator('[data-edge="dns-b"]')).toHaveClass(/highlight/);
  const dns = await page.locator("#maturity-edges .dns").evaluateAll((paths) =>
    paths.map((path) => [path.getPointAtLength(0).x, path.getPointAtLength(path.getTotalLength()).x]));
  expect(dns).toEqual([[65, 65], [125, 125]]);
});

test("OFFLINE GUIDE: APIM routes stay clear and acceptance arrows point back to the client", async ({ page }) => {
  await page.goto(walkthroughUrl);
  for (const scenario of ["normal", "degraded", "failover"]) {
    await page.locator(`[data-scenario="${scenario}"]`).click();
    const next = page.locator("#next");
    do {
      await expectClearRoutes(page, ".topology", "path.route", "rect.node");
      if (await next.isDisabled()) break;
      await next.click();
    } while (true);
  }
  await page.locator('[data-scenario="normal"]').click();
  await page.locator("#next").click();
  for (const route of ["client", "primary"]) {
    await expect(page.locator(`#${route}-route`)).toHaveAttribute("marker-start", "url(#arrow-active)");
    await expect(page.locator(`#${route}-route`)).toHaveAttribute("marker-end", "none");
    await expect(page.locator(`#${route}-route`)).toHaveClass(/reverse/);
  }
  await page.locator("#next").click();
  await expect(page.locator("#primary-route")).toHaveAttribute("marker-end", "url(#arrow-active)");
  await expect(page.locator("#primary-route")).toHaveAttribute("marker-start", "none");
});

test("OFFLINE GUIDE: header navigation has a local GitHub mark, works both ways and fits mobile", async ({ page }) => {
  for (const url of [architectureUrl, walkthroughUrl]) {
    await page.goto(url);
    const navigation = page.getByRole("navigation", { name: "Guide navigation" });
    const repository = navigation.getByRole("link", { name: "GitHub repository" });
    await expect(repository).toHaveAttribute("href", "https://github.com/jfilcik/content-understanding-availability-patterns");
    await expect(repository.locator("svg")).toBeVisible();
    await expect(repository.locator("svg")).toHaveAttribute("aria-hidden", "true");
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(repository).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const links = await navigation.getByRole("link").evaluateAll((anchors) =>
        anchors.map((anchor) => anchor.getBoundingClientRect().height));
      expect(links.every((height) => height >= 44)).toBe(true);
    }
  }
  await page.getByRole("navigation").getByRole("link", { name: "Availability guide", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(architectureUrl);
  await page.getByRole("navigation").getByRole("link", { name: "APIM walkthrough", exact: true }).click();
  await expect(page).toHaveURL(walkthroughUrl);
});
