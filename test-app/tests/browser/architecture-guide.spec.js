import { test, expect } from "@playwright/test";

const guideUrl = new URL("../../../single-apim-failover.html", import.meta.url).href;

async function walkScenario(page, name) {
  const button = page.getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  const steps = [];
  const next = page.getByRole("button", { name: "Next step", exact: true });
  for (let index = 0; index < 16; index++) {
    steps.push({
      title: await page.locator("#step-title").innerText(),
      before: await page.locator("#before").innerText(),
      after: await page.locator("#after").innerText(),
      note: await page.locator("#step-note").innerText(),
    });
    if (await next.isDisabled()) break;
    await next.click();
  }
  await expect(next).toBeDisabled();
  return steps;
}

test("OFFLINE GUIDE: all scenarios teach rewrites, POST-to-success duration and old-job affinity without health checks", async ({ page }) => {
  const network = [];
  const errors = [];
  page.on("request", (request) => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(guideUrl);
  await expect(page.locator("#work-in-progress")).toBeVisible();
  await expect(page.locator("#work-in-progress")).toContainText("Work in progress (WIP).");

  const normal = await walkScenario(page, "1. Normal operations");
  expect(normal).toHaveLength(4);
  expect(normal[0].before).toContain("POST https://gateway.example.invalid/");
  expect(normal[0].after).toContain("POST https://cu-primary.example.invalid/");
  expect(normal[1].before).toContain("Operation-Location: https://cu-primary.example.invalid/");
  expect(normal[1].after).toContain("Operation-Location: https://gateway.example.invalid/");
  expect(normal[1].after).toContain("gateway-token=");
  expect(normal[2].before).toContain("gateway-token=");
  expect(normal[2].after).toContain("GET https://cu-primary.example.invalid/");
  expect(normal[2].after).not.toContain("gateway-token");

  const degraded = await walkScenario(page, "2. Degraded primary");
  expect(degraded).toHaveLength(6);
  expect(degraded[2].after).toContain("Signed operation age: 60s");
  expect(degraded[2].note).toContain("exactly 60s does not switch");
  expect(degraded[3].after).toContain("Signed operation age: 61s");
  expect(degraded[3].after).toContain('"status":"Succeeded"');
  expect(degraded[3].note).toContain("qualifies");
  expect(degraded[3].note).toContain("completion-latency");
  expect(degraded[4].before).toContain('If-Match: "synthetic-v1"');
  expect(degraded[4].after).toContain("accepted-awaiting-activation");
  expect(degraded[4].after).toContain("still primary-cu");
  expect(degraded[5].after).toContain("Analyze may still use primary-cu");

  const failover = await walkScenario(page, "3. Failover");
  expect(failover).toHaveLength(5);
  expect(failover[2].after).toContain("POST https://cu-secondary.example.invalid/");
  expect(failover[3].before).toContain("GET https://gateway.example.invalid/");
  expect(failover[3].after).toContain("GET https://cu-primary.example.invalid/");
  expect(failover[3].after).not.toContain("gateway-token");
  expect(failover[4].before).toContain("active-backend: secondary-cu (unchanged)");
  expect(failover[4].after).toContain("Manual reset: active-backend -> primary-cu");
  expect(network).toEqual([]);
  expect(errors).toEqual([]);
});

test("OFFLINE GUIDE: playback, pause, restart, motion and keyboard controls work independently of simulated job age", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-22T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-22T12:00:01Z"));
  await page.goto(guideUrl);
  await expect(page.locator("#step-count")).toHaveText("Step 1 of 4");
  await page.getByRole("button", { name: "Play walkthrough", exact: true }).click();
  await page.clock.runFor(5_100);
  await expect(page.locator("#step-count")).toHaveText("Step 2 of 4");
  await page.getByRole("button", { name: "Pause walkthrough", exact: true }).click();
  await page.clock.runFor(6_000);
  await expect(page.locator("#step-count")).toHaveText("Step 2 of 4");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.locator("#step-count")).toHaveText("Step 1 of 4");
  await page.getByLabel("Animate request paths", { exact: true }).uncheck();
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length)).toBe(0);
  const failover = page.getByRole("button", { name: "3. Failover", exact: true });
  await failover.focus();
  await page.keyboard.press("Enter");
  await expect(failover).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#step-count")).toHaveText("Step 1 of 5");
  await page.getByRole("button", { name: "Next step", exact: true }).click();
  await page.getByRole("button", { name: "Restart scenario", exact: true }).click();
  await expect(page.locator("#step-count")).toHaveText("Step 1 of 5");
});

test("OFFLINE GUIDE: reduced motion and mobile token inspection preserve readable, unverified synthetic claims", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(guideUrl);
  expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length)).toBe(0);
  await page.getByText("Inspect the example signed token", { exact: true }).click();
  await expect(page.locator("#claims")).toBeVisible();
  const claims = JSON.parse(await page.locator("#claims").textContent());
  expect(Object.keys(claims).sort()).toEqual(["analyzer", "apiVersion", "gateway", "operation", "region", "started", "subscription"]);
  expect(claims.region).toBe("swedencentral");
  await expect(page.getByText("Locally decoded example claims (not verified)", { exact: true })).toBeVisible();
  await expect(page.getByText("Signed, not encrypted.", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic token only: its signature is deliberately invalid. Never send it to APIM.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Next step", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#step-count")).toHaveText("Step 2 of 4");
});
