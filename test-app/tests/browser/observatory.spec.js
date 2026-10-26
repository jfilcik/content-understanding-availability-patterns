import { test, expect } from "@playwright/test";
import { MOCK_CONFIG, MOCK_KEY, pollUrl, routingToken, signedPollUrl } from "../fixtures.js";
import { SAMPLE_DOCUMENT_URL } from "../../core.js";

const cors = {
  "access-control-allow-origin": `http://127.0.0.1:${process.env.CU_OBSERVATORY_TEST_PORT || 5174}`,
  "access-control-allow-headers": "Content-Type, Ocp-Apim-Subscription-Key",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-expose-headers": "Operation-Location, Retry-After, X-CU-Region, X-CU-Gateway, X-CU-Elapsed-Seconds, X-CU-Backend, X-CU-Active-Backend, X-CU-Switch-Status, X-CU-Latency-Threshold-Seconds, X-CU-Degradation-Reason, X-CU-Trigger",
};
const fulfill = (route, status, body = "", headers = {}) => route.fulfill({
  status, headers: { ...cors, "content-type": "application/json",
    ...(status === 202 && route.request().method() === "POST" ? {
      "X-CU-Region": "eastus", "X-CU-Gateway": "apim-single",
      "X-CU-Backend": headers["X-CU-Region"] === "westus" ? "secondary-cu" : "primary-cu",
    } : {}), ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

test("LOCAL STATIC DOM: labeled controls, keyboard focus, and desktop/mobile rendering", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("See where your analysis runs.");
  await expect(page.locator("#document-url")).toHaveValue(SAMPLE_DOCUMENT_URL);
  await expect(page.getByRole("button", { name: "Test failover · 2s" })).toBeDisabled();
  await expect(page.locator("#reset-primary")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Restore test threshold" })).toBeDisabled();
  expect(await page.locator("input, select, textarea").evaluateAll((controls) =>
    controls.every((control) => control.labels.length > 0),
  )).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
});

test("LOCAL STATIC DOM: regional names remain readable beside long observation badges", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#document-url")).toHaveValue(SAMPLE_DOCUMENT_URL);
  await page.getByRole("tab", { name: "Routes & resources" }).click();
  await page.locator("#region-a-title").evaluate((node) => { node.textContent = "Primary"; });
  await page.locator("#region-b-title").evaluate((node) => { node.textContent = "Secondary"; });
  await page.locator("#gateway-observation-state").evaluate((node) => { node.textContent = "Last observed on analysis response"; });
  for (const width of [1536, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const layout = await page.locator(".apim-resource > summary").evaluateAll((nodes) => nodes.map((node) => {
      const title = node.querySelector("strong");
      const badge = node.querySelector(".badge");
      return {
        titleHeight: title.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(title).lineHeight),
        badgeBottom: badge.getBoundingClientRect().bottom,
        summaryBottom: node.getBoundingClientRect().bottom,
      };
    }));
    for (const region of layout) {
      expect(region.titleHeight).toBeLessThanOrEqual(region.lineHeight + 1);
      expect(region.badgeBottom).toBeLessThanOrEqual(region.summaryBottom);
    }
  }
});

async function connect(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#document-url")).toHaveValue(SAMPLE_DOCUMENT_URL);
  await page.getByRole("tab", { name: "Routes & resources" }).click();
  await page.locator(".resource-node").evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
  await page.locator("#gateway-url").fill(MOCK_CONFIG.gatewayUrl);
  await page.locator("#region-a-region").fill("eastus");
  await page.locator("#region-b-region").fill("westus");
  await page.locator("#region-a-label").fill("East");
  await page.locator("#region-b-label").fill("West");
  await page.getByRole("button", { name: "Apply connections" }).click();
  await page.getByLabel("Serving APIM subscription key").fill(MOCK_KEY);
  await page.getByRole("button", { name: "Use key for this tab" }).click();
  await expect(page.locator("#subscription-key")).toHaveValue("");
}

async function submitDocument(page) {
  await page.getByLabel("HTTPS document URL", { exact: false }).fill("https://documents.example/private-invoice.pdf?sig=document-secret");
  await page.getByRole("button", { name: "Submit one analysis" }).click();
}

test("MOCK NETWORK: real DOM supports global steering with old jobs pinned, result redaction, and no persistence", async ({ page }) => {
  const requests = [];
  let posts = 0;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", {
    value: { writeText: async (value) => { window.mockCopiedPollingUrl = value; } },
  }));
  await page.clock.install();
  await page.route("https://gateway.example/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return fulfill(route, 204);
    requests.push({ method: request.method(), url: request.url(), body: request.postData() });
    if (request.method() === "POST") {
      const region = ++posts === 1 ? "a" : "b";
      return fulfill(route, 202, "", {
        "Operation-Location": pollUrl(region, `op-${posts}`),
        "X-CU-Region": region === "a" ? "eastus" : "westus", "X-CU-Gateway": `apim-${region}`, "Retry-After": "3",
      });
    }
    return fulfill(route, 200, {
      status: new URL(request.url()).searchParams.get("fixture-region") === "a" ? "Running" : "Succeeded",
      result: { text: "<img src=x onerror='window.injected=true'>", leaked: MOCK_KEY, token: "mock+timing/token=" },
    }, { "X-CU-Elapsed-Seconds": "65" });
  });
  await connect(page);
  await submitDocument(page);
  await expect(page.locator('[data-job="job-001"]')).toContainText("East");
  await submitDocument(page);
  await expect(page.locator("#timeline")).toContainText("same APIM");
  await page.clock.runFor(3_100);
  await expect(page.locator('[data-job="job-001"]')).toContainText("Running");
  await expect(page.locator('[data-job="job-002"]')).toContainText("Succeeded");
  expect(requests.filter((request) => request.method === "GET").map((request) => request.url)).toEqual(expect.arrayContaining([pollUrl("a", "op-1"), pollUrl("b", "op-2")]));
  await page.getByRole("button", { name: "Details for job-002" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator("#detail-url")).not.toHaveValue(/mock%2Btiming/);
  await expect(page.locator("#detail-result")).toContainText("<img");
  await expect(page.locator("#detail-result")).not.toContainText(MOCK_KEY);
  await expect(page.locator("#detail-result")).not.toContainText("mock+timing/token=");
  await expect(page.locator("#detail-fields")).toContainText("65s from POST arrival to successful result");
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(await page.evaluate(() => window.mockCopiedPollingUrl)).toBeUndefined();
  await page.getByRole("button", { name: "Copy full polling URL" }).click();
  expect(await page.evaluate(() => window.mockCopiedPollingUrl)).toBe(pollUrl("b", "op-2"));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const timeline = await page.locator("#timeline").textContent();
  expect(timeline).not.toContain("private-invoice");
  expect(timeline).not.toContain("document-secret");
  expect(timeline).not.toContain(MOCK_KEY);
  expect(timeline).not.toContain("mock+timing");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#key-state")).toHaveText("Key not set");
  await expect(page.locator("#job-count")).toHaveText("0");
  expect(errors).toEqual([]);
});

test("MOCK NETWORK: unsafe and redirecting operation URLs never forward the serving key", async ({ page }) => {
  let posts = 0;
  const leaked = [];
  page.on("request", (request) => {
    if (request.url().startsWith("https://evil.example")) leaked.push(request.headers());
  });
  await page.clock.install();
  await page.route("https://gateway.example/**", (route) => {
    if (route.request().method() === "OPTIONS") return fulfill(route, 204);
    if (route.request().method() === "GET") return fulfill(route, 302, "", { Location: "https://evil.example/stolen" });
    posts++;
    return fulfill(route, 202, "", { "Operation-Location": posts === 1 ? "https://evil.example/result?api-version=v" : pollUrl() });
  });
  await page.route("https://evil.example/**", (route) => fulfill(route, 200, { status: "Succeeded" }));
  await connect(page);
  await submitDocument(page);
  await expect(page.locator('[data-job="job-001"]')).toContainText("polling blocked");
  await submitDocument(page);
  await page.clock.runFor(3_100);
  await expect(page.getByRole("button", { name: "Resume monitoring for job-002" })).toBeEnabled();
  expect(leaked).toEqual([]);
  expect(posts).toBe(2);
});

test("MOCK NETWORK: single-gateway binary body, pause/resume, Retry-After and failures", async ({ page }) => {
  let posts = 0;
  let gets = 0;
  await page.clock.install();
  await page.route("https://gateway.example/**", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return fulfill(route, 204);
    if (request.method() === "POST") {
      posts++;
      expect(request.url()).toContain(":analyzeBinary?");
      expect(request.headers()["content-type"]).toBe("application/pdf");
      expect(request.postDataBuffer().toString()).toBe("%PDF-mock contents");
      return fulfill(route, 202, "", { "Operation-Location": pollUrl(), "Retry-After": "10" });
    }
    gets++;
    return fulfill(route, 200, { status: "Failed", error: { code: "InvalidDocument", message: "Controlled mock failure" } });
  });
  await connect(page, false);
  await expect(page.locator("#connection-state")).toContainText("Single APIM");
  await expect(page.locator("#route-help")).toContainText("One APIM");
  await page.getByRole("radio", { name: "Binary file" }).check();
  await page.locator("#document-file").setInputFiles({ name: "mock.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-mock contents") });
  await page.getByRole("button", { name: "Submit one analysis" }).click();
  await expect(page.locator("#job-count")).toHaveText("1");
  await page.locator("#trace-body tr").filter({ hasText: ":analyzeBinary?" }).getByRole("button").click();
  await expect(page.locator("#route-context")).toContainText("single APIM");
  await expect(page.locator("#apim-details")).toHaveClass(/active-route/);
  await expect(page.locator("#cu-a-details")).toHaveClass(/active-route/);
  await expect(page.locator("#cu-b-details")).not.toHaveClass(/active-route/);
  await page.getByRole("button", { name: "Pause monitoring for job-001" }).click();
  await page.clock.runFor(5_000);
  await page.getByRole("button", { name: "Resume monitoring for job-001" }).click();
  await page.clock.runFor(4_000);
  expect(gets).toBe(0);
  await page.clock.runFor(1_100);
  await expect(page.locator('[data-job="job-001"]')).toContainText("Failed");
  expect(posts).toBe(1);
  expect(gets).toBe(1);
});

test("MOCK NETWORK: real POST and successful GET expose timing and runtime selection without probes", async ({ page }) => {
  const calls = [];
  await page.clock.install();
  await page.route("https://gateway.example/**", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return fulfill(route, 204);
    calls.push(request.url());
    expect(request.url()).not.toContain("/health");
    if (request.method() === "POST") return fulfill(route, 202, "", {
      "Operation-Location": pollUrl(), "X-CU-Active-Backend": "primary-cu", "X-CU-Latency-Threshold-Seconds": "60",
      "X-CU-Trigger": "operation-duration",
    });
    return fulfill(route, 200, { status: "Succeeded" }, {
      "X-CU-Active-Backend": "secondary-cu", "X-CU-Latency-Threshold-Seconds": "2",
      "X-CU-Elapsed-Seconds": "65", "X-CU-Degradation-Reason": "completion-latency",
      "X-CU-Trigger": "operation-duration",
    });
  });
  await connect(page);
  expect(calls).toHaveLength(0);
  await expect(page.locator("#gateway-observation-state")).toHaveText("No analysis observed yet");
  await expect(page.locator("#gateway-fields")).toContainText("updated policy activation is not established");
  await submitDocument(page);
  await expect(page.locator("#gateway-fields")).toContainText("primary-cu");
  await expect(page.locator("#gateway-fields")).toContainText("POST → result duration: pending and successful results");
  await expect(page.locator("#gateway-fields").getByText("Last analysis response threshold", { exact: true }).locator("..").locator("dd")).toHaveText("60s");
  await page.clock.runFor(3_100);
  await expect(page.locator('[data-job="job-001"]')).toContainText("65s · POST → success");
  await expect(page.locator("#test-failover-status")).toContainText("Last analysis response selection: secondary-cu");
  await expect(page.locator("#gateway-observation-state")).toHaveText("Observed on real request");
  await expect(page.locator("#gateway-fields").getByText("Last analysis response threshold", { exact: true }).locator("..").locator("dd")).toHaveText("2s");
  await page.getByRole("tab", { name: "Request inspector" }).click();
  await page.locator("#trace-body tr").filter({ hasText: "/analyzerResults/" }).getByRole("button").click();
  await expect(page.locator("#request-fields")).toContainText("completion-latency");
  await expect(page.locator("#request-fields")).toContainText("65s");
  await page.clock.runFor(60_000);
  expect(calls).toHaveLength(2);
  await page.getByRole("button", { name: "Clear trace" }).click();
  await expect(page.locator("#test-failover-status")).toContainText("secondary-cu");
});

test("MOCK NETWORK: legacy response metadata never claims slow-success policy activation", async ({ page }) => {
  await page.clock.install();
  await page.route("https://gateway.example/**", (route) => {
    if (route.request().method() === "OPTIONS") return fulfill(route, 204);
    return fulfill(route, route.request().method() === "POST" ? 202 : 200, "", {
      "Operation-Location": pollUrl(), "X-CU-Active-Backend": "primary-cu", "X-CU-Trigger": "pending-status",
    });
  });
  await connect(page);
  await submitDocument(page);
  await expect(page.locator("#gateway-fields")).toContainText("Legacy pending-only policy");
  await expect(page.locator("#gateway-fields")).toContainText("Redeploy the updated policy for slow-success detection");
  await expect(page.locator("#gateway-fields").getByText("Last analysis response threshold", { exact: true }).locator("..").locator("dd")).toHaveText("Not observed");
});

test("MOCK NETWORK: retained URL, keyboard access, safe configuration import and mobile layout", async ({ page }) => {
  let requests = 0;
  await page.route("https://gateway.example/**", (route) => {
    if (route.request().method() === "OPTIONS") return fulfill(route, 204);
    requests++;
    expect(route.request().method()).toBe("GET");
    return fulfill(route, 200, { status: "Succeeded", result: { analyzerId: "receipt" } });
  });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to workbench" })).toBeFocused();
  await page.getByRole("tab", { name: "Routes & resources" }).click();
  await page.locator("#config-import").setInputFiles({ name: "configuration.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(MOCK_CONFIG)) });
  await expect(page.locator("#connection-state")).toHaveText("Single APIM configured");
  await page.getByLabel("Serving APIM subscription key").fill(MOCK_KEY);
  await page.getByRole("button", { name: "Use key for this tab" }).click();
  await page.getByText("Resume a retained regional polling URL", { exact: true }).click();
  await page.getByLabel("Complete Operation-Location").fill(pollUrl("b"));
  await page.getByRole("button", { name: "Monitor retained operation" }).click();
  await expect(page.locator('[data-job="job-001"]')).toContainText("Succeeded");
  await expect(page.getByLabel("Complete Operation-Location")).toHaveValue("");
  expect(requests).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Details for job-001" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("#detail-url")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Details for job-001" })).toBeFocused();
});

test("MOCK NETWORK: an idle configured app never sends APIM health checks", async ({ page }) => {
  let requests = 0;
  await page.clock.install();
  await page.route("https://gateway.example/**", (route) => {
    requests++;
    return fulfill(route, 500);
  });
  await connect(page);
  await page.clock.runFor(120_000);
  expect(requests).toBe(0);
  await expect(page.locator("#refresh-health, #auto-health, #gateway-health")).toHaveCount(0);
});

test("MOCK NETWORK: clearing a key cannot reveal echoed credentials in an already displayed result", async ({ page }) => {
  await page.clock.install();
  await page.route("https://gateway.example/**", (route) => {
    if (route.request().method() === "OPTIONS") return fulfill(route, 204);
    if (route.request().method() === "POST") return fulfill(route, 202, "", { "Operation-Location": pollUrl() });
    return fulfill(route, 200, { status: "Succeeded", result: { accidentallyEchoedKey: MOCK_KEY } });
  });
  await connect(page);
  await submitDocument(page);
  await expect(page.locator('[data-job="job-001"]')).toContainText("Accepted");
  await page.clock.runFor(3_100);
  await expect(page.locator('[data-job="job-001"]')).toContainText("Succeeded");
  await page.getByRole("button", { name: "Details for job-001" }).click();
  await expect(page.locator("#detail-result")).not.toContainText(MOCK_KEY);
  await page.keyboard.press("Escape");
  await page.locator("#key-setup > summary").click();
  await page.getByRole("button", { name: "Clear key & pause" }).click();
  await page.getByRole("button", { name: "Details for job-001" }).click();
  await expect(page.locator("#detail-result")).not.toContainText(MOCK_KEY);
  await expect(page.locator("#detail-result")).toContainText("[redacted]");
});

test("MOCK NETWORK: provisioning failures come from the real POST and never cause automatic replay", async ({ page }) => {
  let posts = 0;
  await page.clock.install();
  await page.route("https://gateway.example/**", (route) => {
    if (route.request().method() === "OPTIONS") return fulfill(route, 204);
    expect(route.request().method()).toBe("POST");
    posts++;
    return fulfill(route, 503, { error: { code: "GatewayNotConfigured" } }, { "Retry-After": "30" });
  });
  await connect(page);
  await expect(page.locator("#submit-button")).toBeEnabled();
  await submitDocument(page);
  await expect(page.locator("#feedback")).toContainText("provisioning is incomplete");
  await expect(page.locator('[data-job="job-001"]')).toContainText("Rejected · 503");
  await page.clock.runFor(60_000);
  expect(posts).toBe(1);
});

test("MOCK NETWORK: selectable request trace shows individual polls, redacted details and persistent document input", async ({ page }) => {
  await page.clock.install();
  await page.route("https://gateway.example/**", (route) => {
    if (route.request().method() === "OPTIONS") return fulfill(route, 204);
    if (route.request().method() === "POST") return fulfill(route, 202, "", { "Operation-Location": pollUrl(), "Retry-After": "3" });
    return fulfill(route, 200, { status: "Succeeded", result: { content: "Synthetic result", echoed: MOCK_KEY } }, { "X-CU-Elapsed-Seconds": "6.5" });
  });
  await connect(page);
  await submitDocument(page);
  await expect(page.locator("#document-url")).toHaveValue("https://documents.example/private-invoice.pdf?sig=document-secret");
  await page.clock.runFor(3_100);
  await expect(page.locator("#trace-filter")).toHaveValue("analysis");
  await page.getByRole("tab", { name: "Request inspector" }).click();
  const post = page.locator("#trace-body tr").filter({ hasText: ":analyze?" });
  await post.getByRole("button").click();
  await expect(page.locator("#request-body")).toContainText("private-invoice.pdf");
  await expect(page.locator("#request-body")).not.toContainText("document-secret");
  await expect(page.locator("#request-headers")).not.toContainText(MOCK_KEY);
  const poll = page.locator("#trace-body tr").filter({ hasText: "/analyzerResults/" });
  await poll.getByRole("button").click();
  await expect(page.locator("#request-url")).toHaveValue(/https:\/\/gateway\.example\/contentunderstanding\/analyzerResults\/op-01/);
  await expect(page.locator("#request-url")).not.toHaveValue(/mock%2Btiming/);
  await expect(page.locator("#response-body")).toContainText("Synthetic result");
  await expect(page.locator("#response-body")).not.toContainText(MOCK_KEY);
  await expect(page.locator("#request-fields")).toContainText("6.5s");
  await expect(page.locator("#apim-details")).toHaveClass(/active-route/);
  await page.getByRole("tab", { name: "Routes & resources" }).click();
  await expect(page.locator("#route-context")).toContainText("signed accepting CU backend");
  await expect(page.locator("#route-context")).toContainText("original URL is unchanged");
  await expect(page.locator("#cu-a-details")).toHaveClass(/active-route/);
  await expect(page.locator("#cu-b-details")).not.toHaveClass(/active-route/);
  await post.getByRole("button").click();
  await expect(page.getByRole("tab", { name: "Routes & resources" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#apim-details")).toHaveClass(/active-route/);
  await expect(page.locator("#route-context")).toContainText("single APIM");
  await page.getByRole("tab", { name: "Request inspector" }).click();
  await expect(page.locator("#request-kind")).toHaveText("Analyze");
  await page.getByRole("button", { name: "Clear trace" }).click();
  await expect(page.locator("#request-count")).toHaveText("0");
  await expect(page.locator("#job-count")).toHaveText("1");
});

test("LOCAL STATIC DOM: serving key prerequisite has portal steps and collapses only after setting the key", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#key-setup")).toHaveAttribute("open", "");
  await expect(page.locator("#submit-button")).toBeDisabled();
  await expect(page.locator("#key-title")).toContainText("Before you start");
  await expect(page.locator("#key-setup")).toContainText("APIs → Subscriptions");
  await expect(page.locator("#key-setup")).toContainText("Content Understanding client");
  await expect(page.locator("#key-portal-link")).toHaveAttribute("href", /^https:\/\/portal\.azure\.com\//);
  const keyBox = await page.locator("#key-setup").boundingBox();
  const composer = await page.locator(".composer").boundingBox();
  expect(keyBox.y + keyBox.height).toBeLessThan(composer.y);
  await connect(page);
  await expect(page.locator("#key-state")).toHaveText("Key in memory");
  await expect(page.locator("#key-setup")).not.toHaveAttribute("open", "");
  await expect(page.locator("#key-title")).toHaveText("APIM subscription key is ready");
  await expect(page.locator("#submit-button")).toBeEnabled();
  await page.locator("#key-setup > summary").click();
  await expect(page.locator("#subscription-key")).toHaveValue("");
  await page.getByRole("button", { name: "Clear key & pause" }).click();
  await expect(page.locator("#key-setup")).toHaveAttribute("open", "");
  await expect(page.locator("#subscription-key")).toBeFocused();
  await expect(page.locator("#submit-button")).toBeDisabled();
  await expect(page.locator("#key-state")).toHaveText("Key not set");
});

test("LOCAL STATIC DOM: detail tabs support keyboard navigation and share the right pane", async ({ page }) => {
  await page.goto("/");
  const inspector = page.getByRole("tab", { name: "Request inspector" });
  const routes = page.getByRole("tab", { name: "Routes & resources" });
  await expect(routes).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#routes-panel")).toBeVisible();
  await expect(page.locator("#inspector-panel")).toBeHidden();
  await routes.focus();
  await page.keyboard.press("ArrowRight");
  await expect(inspector).toBeFocused();
  await expect(inspector).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#routes-panel")).toBeHidden();
  await expect(page.locator("#inspector-panel")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(routes).toBeFocused();
  await page.keyboard.press("End");
  await expect(inspector).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(routes).toBeFocused();
  const traceBox = await page.locator("#trace-pane").boundingBox();
  const detailBox = await page.locator("#detail-pane").boundingBox();
  expect(traceBox.x + traceBox.width).toBeLessThan(detailBox.x);
  expect(Math.abs(traceBox.y - detailBox.y)).toBeLessThan(1);
});

test("LOCAL STATIC DOM: divider drags, supports keyboard bounds and resets without horizontal overflow", async ({ page }) => {
  await page.goto("/");
  await page.setViewportSize({ width: 1536, height: 1000 });
  const divider = page.getByRole("separator");
  await divider.scrollIntoViewIfNeeded();
  const initial = await page.locator("#trace-pane").boundingBox();
  let bounds = await divider.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 45);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 150, bounds.y + 45, { steps: 8 });
  await page.mouse.up();
  const wider = await page.locator("#trace-pane").boundingBox();
  expect(wider.width).toBeGreaterThan(initial.width + 100);
  bounds = await divider.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 45);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 300, bounds.y + 45, { steps: 8 });
  await page.mouse.up();
  const narrower = await page.locator("#trace-pane").boundingBox();
  expect(narrower.width).toBeLessThan(initial.width - 100);
  await divider.focus();
  await page.keyboard.press("Home");
  await expect(divider).toHaveAttribute("aria-valuenow", "20");
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "20");
  await page.keyboard.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "80");
  await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "80");
  await page.getByRole("tab", { name: "Routes & resources" }).click();
  await page.locator(".resource-node").evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await divider.dblclick();
  await expect(divider).toHaveAttribute("aria-valuenow", "55");
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await page.keyboard.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "55");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(divider).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  bounds = await page.locator("#trace-pane").boundingBox();
  const details = await page.locator("#detail-pane").boundingBox();
  expect(details.y).toBeGreaterThan(bounds.y + bounds.height);
});

test("MOCK NETWORK: analysis filter hides local management reads and never invents a CU hop", async ({ page }) => {
  await connect(page, false);
  await expect(page.locator("#trace-filter")).toHaveValue("analysis");
  await expect(page.locator("#trace-body .trace-link:visible")).toHaveCount(0);
  await expect(page.locator("#trace-body")).toContainText("No requests match this filter");
  await expect(page.locator("#request-count")).toHaveText("0 / 1");
  await page.locator("#trace-filter").selectOption("all");
  await expect(page.locator("#trace-body .trace-link:visible")).toHaveCount(1);
  await page.locator("#trace-body tr").filter({ hasText: "Azure control" }).first().getByRole("button").click();
  await expect(page.locator("#route-context")).toContainText("Management-plane request only");
  await expect(page.locator("#apim-details")).toHaveClass(/active-route/);
  await expect(page.locator("#cu-a-details")).not.toHaveClass(/active-route/);
  await expect(page.locator("#cu-b-details")).not.toHaveClass(/active-route/);
});

test("MOCK CONTROL PLANE: one gateway, temporary 2s/5s thresholds, sticky selection, reset and old-job affinity", async ({ page }, testInfo) => {
  await page.clock.install();
  const config = MOCK_CONFIG;
  const state = {
    enabled: true, csrfToken: "private-test-control-token", config, checkedAt: Date.now() / 1000, error: null,
    deployment: {
      subscription: "test-subscription", resourceGroup: "test-group", model: "test-model", embeddingModel: "test-embedding",
      gateway: { resourceId: "/test/apim-single", url: config.gatewayUrl },
      regions: config.regions.map((region) => ({ ...region, cuEndpoint: `https://cu-${region.id}.example`, foundryResourceId: `/test/cu-${region.id}` })),
    },
    thresholdSeconds: 60, activeBackend: "primary-cu", leases: [],
  };
  const controlCalls = [];
  const dataCalls = [];
  await page.route("**/api/control/**", async (route) => {
    const req = route.request();
    expect(req.headers()["ocp-apim-subscription-key"]).toBeUndefined();
    if (req.method() === "POST") {
      expect(req.headers()["x-cu-control-token"]).toBe("private-test-control-token");
      const body = req.postDataJSON();
      controlCalls.push(body);
      if (req.url().endsWith("/apply")) {
        state.leases.push({ ...body, original: String(state.thresholdSeconds), temporary: String(body.thresholdSeconds),
          status: "active", expiresAt: Date.now() / 1000 + body.durationSeconds });
        state.thresholdSeconds = body.thresholdSeconds;
      } else if (req.url().endsWith("/select")) {
        state.activeBackend = body.backendId;
      } else {
        state.leases = state.leases.filter((lease) => lease.kind !== body.kind || lease.regionId !== body.regionId);
        state.thresholdSeconds = 60;
      }
    }
    return fulfill(route, 200, state);
  });
  await page.route("https://gateway.example/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return fulfill(route, 204);
    expect(req.url()).not.toContain("/health");
    const runtime = { "X-CU-Active-Backend": state.activeBackend, "X-CU-Latency-Threshold-Seconds": String(state.thresholdSeconds) };
    dataCalls.push({ method: req.method(), url: req.url() });
    const region = req.method() === "POST" ? state.activeBackend === "primary-cu" ? "a" : "b"
      : new URL(req.url()).searchParams.get("fixture-region");
    if (req.method() === "POST") return fulfill(route, 202, "", {
      "Operation-Location": pollUrl(region, `op-${region}`), "Retry-After": "3", "X-CU-Region": region === "a" ? "eastus" : "westus", ...runtime,
    });
    return fulfill(route, 200, { status: region === "a" ? "Running" : "Succeeded" }, runtime);
  });
  await page.goto("/");
  await expect(page.locator("#target")).toHaveValue("gateway");
  await expect(page.locator("#key-portal-link")).toHaveAttribute("href", "https://portal.azure.com/#resource/test/apim-single");
  await page.getByLabel("Serving APIM subscription key").fill(MOCK_KEY);
  await page.getByRole("button", { name: "Use key for this tab" }).click();
  await page.getByRole("button", { name: "Submit one analysis" }).click();
  await expect(page.locator("#job-count")).toHaveText("1");
  await page.clock.runFor(3_100);
  await page.getByRole("tab", { name: "Routes & resources" }).click();
  await page.locator("#trace-body tr").filter({ hasText: ":analyze?" }).getByRole("button").click();
  await expect(page.locator("#route-context")).toContainText("single APIM");
  await expect(page.locator("#apim-details")).toHaveClass(/active-route/);
  await page.locator("#apim-details > summary").click();
  await page.getByRole("button", { name: "Apply temporary threshold for Gateway" }).click();
  await expect(page.locator("#controls-gateway")).toContainText("original 60");
  expect(controlCalls[0]).toEqual({ regionId: "gateway", kind: "threshold", durationSeconds: 300, thresholdSeconds: 5 });
  await page.getByRole("button", { name: "Select secondary manually" }).click();
  await page.getByRole("button", { name: "Submit one analysis" }).click();
  await expect(page.locator("#job-count")).toHaveText("2");
  await page.clock.runFor(3_100);
  await expect(page.locator('[data-job="job-001"]')).toContainText("East");
  await expect(page.locator('[data-job="job-002"]')).toContainText("West");
  expect(dataCalls.filter((call) => call.method === "POST").map((call) => new URL(call.url).hostname)).toEqual(["gateway.example", "gateway.example"]);
  expect(dataCalls.filter((call) => call.method === "GET").map((call) => call.url)).toContain(pollUrl("a", "op-a"));
  await expect(page.locator("#timeline")).toContainText("same APIM");
  await expect(page.locator("#trace-body")).not.toContainText("private-test-control-token");
  await page.screenshot({ path: testInfo.outputPath("request-lab.png"), fullPage: true });
  await page.locator("#controls-gateway").getByRole("button", { name: "Restore threshold", exact: true }).click();
  await expect(page.locator("#controls-gateway")).not.toContainText("threshold: active");
  expect(state.activeBackend).toBe("secondary-cu");
  await page.locator("#trace-filter").selectOption("control");
  const threshold = page.locator("#trace-body tr").filter({ hasText: "/api/control/apply" }).first();
  await threshold.getByRole("button").click();
  await expect(page.locator("#route-context")).toContainText("single APIM");
  await expect(page.locator("#apim-details")).toHaveClass(/active-route/);
  const endpoint = page.locator("#trace-body tr").filter({ hasText: "/api/control/select" });
  await endpoint.getByRole("button").click();
  await expect(page.locator("#route-context")).toContainText("single APIM");
  await expect(page.locator("#apim-details")).toHaveClass(/active-route/);
  expect(state.thresholdSeconds).toBe(60);
  await page.getByRole("tab", { name: "Request inspector" }).click();
  const testButton = page.getByRole("button", { name: "Test failover · 2s" });
  for (const seconds of [300, 180]) {
    await page.locator("#control-duration-gateway").selectOption(String(seconds), { force: true });
    await expect(testButton).toBeEnabled();
    await testButton.click();
    await expect(page.locator("#test-failover-status")).toContainText("original 60");
    await page.clock.runFor(3_100);
    await expect(page.locator("#test-failover-status")).toContainText("Last analysis response threshold: 2s");
    expect(controlCalls.at(-1)).toEqual({ regionId: "gateway", kind: "threshold", durationSeconds: seconds, thresholdSeconds: 2 });
    expect(state.thresholdSeconds).toBe(2);
    await expect(testButton).toBeDisabled();
    await expect(page.locator("#threshold-gateway")).toHaveValue("2");
    await page.getByRole("button", { name: "Restore test threshold" }).click();
    await expect(testButton).toBeEnabled();
    await expect(page.getByRole("button", { name: "Restore test threshold" })).toBeDisabled();
    expect(state.thresholdSeconds).toBe(60);
    expect(state.activeBackend).toBe("secondary-cu");
  }
  expect(dataCalls.filter((call) => call.method === "POST")).toHaveLength(2);
  expect(state.leases).toHaveLength(0);
  await page.locator("#reset-primary").click();
  expect(controlCalls.at(-1)).toEqual({ backendId: "primary-cu" });
  await expect(page.locator("#test-failover-status")).toContainText("Management selection: primary-cu");
  await expect(page.locator("#test-failover-status")).toContainText("Last analysis response selection: secondary-cu");
  await expect(page.locator("#gateway-fields")).toContainText("primary-cu");
  expect(state.activeBackend).toBe("primary-cu");
  await page.getByRole("tab", { name: "Request inspector" }).click();
  await page.route("**/api/control/apply", (route) => fulfill(route, 409, { error: "Controlled test: threshold write rejected." }));
  await testButton.click();
  await expect(page.locator("#feedback")).toContainText("threshold write rejected");
  await expect(page.locator("#feedback")).toHaveClass(/error/);
  expect(state.thresholdSeconds).toBe(60);
  expect(state.leases).toHaveLength(0);
});

async function learningScenario(page, { region = "a", claims = {}, withHelper = true } = {}) {
  await page.clock.install({ time: new Date("2026-10-24T12:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-24T12:00:01Z"));
  const operation = `op-learning-${region}`;
  const url = signedPollUrl(region, operation, claims);
  const backend = MOCK_CONFIG.regions.find((candidate) => candidate.id === region);
  const other = MOCK_CONFIG.regions.find((candidate) => candidate.id !== region);
  const calls = [];
  await page.route("**/api/control/**", (route) => {
    expect(route.request().method()).toBe("GET");
    return fulfill(route, 200, withHelper ? {
      enabled: true, csrfToken: "mock-control-token", config: MOCK_CONFIG,
      checkedAt: Date.now() / 1000, error: null, activeBackend: other.backendId, thresholdSeconds: 60, leases: [],
      deployment: {
        subscription: "mock-subscription", resourceGroup: "mock-group",
        gateway: { resourceId: "/test/apim-single", url: MOCK_CONFIG.gatewayUrl },
        regions: MOCK_CONFIG.regions.map((candidate) => ({
          ...candidate, cuEndpoint: `https://cu-${candidate.id}.example`, foundryResourceId: `/test/cu-${candidate.id}`,
        })),
      },
    } : { enabled: false });
  });
  await page.route("https://gateway.example/**", (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return fulfill(route, 204);
    expect(req.url()).not.toContain("/health");
    calls.push({ method: req.method(), url: req.url() });
    const post = req.method() === "POST";
    return fulfill(route, post ? 202 : 200, { id: operation, status: post ? "Running" : "Succeeded" }, {
      ...(post ? { "Operation-Location": url, "Retry-After": "3" } : {}),
      "X-CU-Region": backend.region, "X-CU-Backend": backend.backendId,
      "X-CU-Active-Backend": post ? backend.backendId : other.backendId,
    });
  });
  await connect(page);
  await submitDocument(page);
  await expect(page.locator("#job-count")).toHaveText("1");
  return { operation, url, token: new URL(url).searchParams.get("gateway-token"), backend, other, calls };
}

for (const region of ["a", "b"]) {
  test(`MOCK LEARNING: ${region === "a" ? "primary" : "secondary"} snapshots, token hover/focus and URL rewrites`, async ({ page }, testInfo) => {
    const scenario = await learningScenario(page, { region });
    const evidence = (name) => page.locator("#routing-evidence-fields > div")
      .filter({ has: page.getByText(name, { exact: true }) }).locator("dd");
    await expect(page.getByRole("tab", { name: "Routes & resources" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#rewrite-mappings .url-mapping")).toHaveCount(2);
    const maps = await page.locator("#rewrite-mappings code").allTextContents();
    expect(maps[0]).toContain("https://gateway.example/contentunderstanding/analyzers/");
    expect(maps[1]).toContain(`https://cu-${region}.example/contentunderstanding/analyzers/`);
    expect(maps[2]).toContain(`https://cu-${region}.example/contentunderstanding/analyzerResults/`);
    expect(maps[2]).not.toContain("gateway-token");
    expect(maps[3]).toContain("https://gateway.example/contentunderstanding/analyzerResults/");
    expect(maps[3]).toContain("gateway-token=[redacted]");
    await expect(page.locator("#rewrite-mappings")).toContainText("configuration-derived illustration");
    await page.getByRole("tab", { name: "Request inspector" }).click();
    await expect(page.locator("#highlight-operation-id")).toHaveText(scenario.operation);
    await expect(page.locator("#highlight-cu-status")).toHaveText("Running");
    await expect(page.locator("#highlight-location")).toContainText("gateway-token=");
    await expect(evidence("Gateway-reported backend in this response")).toContainText(scenario.backend.backendId);
    await expect(evidence("Operation's observed accepting backend")).toContainText(scenario.backend.backendId);
    await expect(page.locator("#full-token")).toBeEmpty();
    const trigger = page.locator("#inspect-token");
    await expect(trigger).toHaveText(`[cu-${region}] hover for details`);
    await trigger.hover();
    await expect(page.locator("#full-token")).toHaveText(scenario.token);
    await expect(page.locator("#decoded-token-fields")).toContainText(scenario.backend.region);
    await expect(page.locator("#decoded-token-fields")).toContainText(scenario.operation);
    await expect(page.locator("#token-popover")).toContainText("not decrypted");
    await expect(page.locator("#decoded-token-fields")).toContainText("Not verified by this browser");
    await page.locator("#full-token").hover();
    await expect(page.locator("#token-popover")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#full-token")).toBeEmpty();
    await trigger.focus();
    await expect(page.locator("#full-token")).toHaveText(scenario.token);
    await page.clock.runFor(1_100);
    await expect(trigger).toBeFocused();
    await expect(page.locator("#full-token")).toHaveText(scenario.token);
    await page.getByRole("button", { name: "Hide token" }).click();
    await expect(trigger).toBeFocused();
    await expect(page.locator("#full-token")).toBeEmpty();
    await page.clock.runFor(2_000);
    await expect(page.locator('[data-job="job-001"]')).toContainText("Succeeded");
    await expect(page.locator("#highlight-cu-status")).toHaveText("Running");
    await expect(evidence("Active new-work backend in this response")).toContainText(scenario.backend.backendId);
    await trigger.click();
    const poll = page.locator("#trace-body tr").filter({ hasText: `/analyzerResults/${scenario.operation}?` });
    await poll.getByRole("button").click();
    await expect(page.locator("#full-token")).toBeEmpty();
    await expect(page.getByRole("tab", { name: "Request inspector" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#highlight-cu-status")).toHaveText("Succeeded");
    await expect(trigger).toHaveText(`[cu-${region}] hover for details`);
    await expect(page.locator("#operation-location-text")).toHaveText("No Operation-Location header returned.");
    await expect(page.locator("#polled-url")).toBeVisible();
    await expect(evidence("Gateway-reported backend in this response")).toContainText(scenario.backend.backendId);
    await expect(evidence("Active new-work backend in this response")).toContainText(scenario.other.backendId);
    await trigger.focus();
    await expect(page.locator("#full-token")).toHaveText(scenario.token);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#full-token")).toHaveText(scenario.token);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`learning-${region}.png`), fullPage: true });
    await page.getByRole("tab", { name: "Routes & resources" }).click();
    await expect(page.locator("#full-token")).toBeEmpty();
    await expect(page.locator("#decoded-token-fields")).toBeEmpty();
    await expect(page.locator("#rewrite-mappings .url-mapping")).toHaveCount(1);
    const pollMaps = await page.locator("#rewrite-mappings code").allTextContents();
    expect(pollMaps[0]).toContain("gateway-token=");
    expect(pollMaps[1]).toContain(`https://cu-${region}.example/contentunderstanding/analyzerResults/`);
    expect(pollMaps[1]).not.toContain("gateway-token");
    await page.getByRole("tab", { name: "Request inspector" }).click();
    await trigger.focus();
    await page.locator("#key-setup > summary").click();
    await page.getByRole("button", { name: "Clear key & pause" }).click();
    await expect(page.locator("#full-token")).toBeEmpty();
    await expect(trigger).toBeHidden();
    await expect(page.locator("#token-claim-note")).toContainText("serving key is cleared");
    for (const selector of ["#trace-body", "#request-url", "#response-headers", "#response-body"]) {
      const content = await page.locator(selector).evaluate((node) => node.value ?? node.textContent);
      expect(content).not.toContain(scenario.token);
      expect(content).not.toContain(MOCK_KEY);
    }
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(scenario.calls).toEqual([
      { method: "POST", url: "https://gateway.example/contentunderstanding/analyzers/invoice:analyze?api-version=2025-11-01" },
      { method: "GET", url: scenario.url },
    ]);
  });
}

test("MOCK LEARNING: disagreeing token claims never steer requests or invent helper endpoints", async ({ page }) => {
  const scenario = await learningScenario(page, { region: "b", claims: { region: "eastus", started: 0 }, withHelper: false });
  await expect(page.locator("#rewrite-mappings")).toContainText("secondary-cu (westus)");
  await expect(page.locator("#rewrite-mappings")).not.toContainText("https://cu-b.example");
  await page.getByRole("tab", { name: "Request inspector" }).click();
  await expect(page.locator("#token-claim-note")).toContainText("Warning: token claims and response evidence disagree");
  await expect(page.locator("#inspect-token")).toHaveText("[secondary-cu · westus] hover for details");
  await page.locator("#inspect-token").focus();
  await expect(page.locator("#decoded-token-fields")).toContainText("eastus");
  await expect(page.locator('[data-job="job-001"]')).toContainText("West");
  await page.clock.runFor(3_100);
  await expect(page.locator('[data-job="job-001"]')).toContainText("Succeeded");
  expect(scenario.calls.filter((call) => call.method === "GET")).toEqual([{ method: "GET", url: scenario.url }]);
  expect(scenario.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  await page.getByRole("button", { name: "Clear trace" }).click();
  await expect(page.locator("#full-token")).toBeEmpty();
  await expect(page.locator("#decoded-token-fields")).toBeEmpty();
  await expect(page.locator("#job-count")).toHaveText("1");
});

test("MOCK LEARNING: malformed claims are shown as inert text with explicit decoding errors", async ({ page }) => {
  const scenario = await learningScenario(page, { claims: { region: "<img src=x onerror='window.injected=true'>" } });
  await page.getByRole("tab", { name: "Request inspector" }).click();
  await page.locator("#inspect-token").focus();
  await expect(page.locator("#full-token")).toHaveText(scenario.token);
  await expect(page.locator("#token-decode-error")).toContainText("expected routing fields");
  await expect(page.locator("#decoded-token-fields")).toBeEmpty();
  await expect(page.locator("#token-popover img")).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.keyboard.press("Escape");
  await expect(page.locator("#full-token")).toBeEmpty();
});

test("MOCK CONTROL PLANE: top reset preserves threshold, distinguishes activation and guards busy/stale/error/mismatched controls", async ({ page }) => {
  const state = {
    enabled: true, csrfToken: "mock-reset-control-token", config: MOCK_CONFIG,
    checkedAt: Date.now() / 1000, error: null, activeBackend: "secondary-cu", thresholdSeconds: 2, leases: [],
    deployment: {
      subscription: "mock-subscription", resourceGroup: "mock-group",
      gateway: { resourceId: "/test/apim-single", url: MOCK_CONFIG.gatewayUrl },
      regions: MOCK_CONFIG.regions.map((region) => ({
        ...region, cuEndpoint: `https://cu-${region.id}.example`, foundryResourceId: `/test/cu-${region.id}`,
      })),
    },
  };
  const changes = [];
  let finishSelection;
  let rejectSelection = false;
  await page.route("**/api/control/**", async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      expect(request.url()).toMatch(/\/select$/);
      expect(request.headers()["x-cu-control-token"]).toBe("mock-reset-control-token");
      expect(request.headers()["ocp-apim-subscription-key"]).toBeUndefined();
      if (rejectSelection) return fulfill(route, 409, { error: "Mock reset rejected by ETag conflict." });
      changes.push(request.postDataJSON());
      await new Promise((resolve) => { finishSelection = resolve; });
      state.activeBackend = "primary-cu";
    }
    return fulfill(route, 200, state);
  });
  let cuCalls = 0;
  await page.route("https://gateway.example/**", (route) => {
    if (route.request().method() === "OPTIONS") return fulfill(route, 204);
    cuCalls++;
    return fulfill(route, 500);
  });
  await page.goto("/");
  const reset = page.locator("#reset-primary");
  await expect(reset).toBeEnabled();
  await reset.click();
  await expect.poll(() => changes.length).toBe(1);
  await expect(reset).toBeDisabled();
  await expect(page.locator("#test-failover")).toBeDisabled();
  finishSelection();
  await expect(reset).toBeEnabled();
  await expect(page.locator("#feedback")).toContainText("Management selection is primary-cu");
  await expect(page.locator("#test-failover-status")).toContainText("Management selection: primary-cu");
  await expect(page.locator("#test-failover-status")).toContainText("Last analysis response selection: not observed");
  expect(state.thresholdSeconds).toBe(2);
  expect(changes).toEqual([{ backendId: "primary-cu" }]);
  expect(cuCalls).toBe(0);
  await expect(page.locator("#reset-primary-help")).toContainText("does not restore the test threshold");

  rejectSelection = true;
  await reset.click();
  await expect(page.locator("#feedback")).toContainText("ETag conflict");
  await expect(page.locator("#feedback")).toHaveClass(/error/);
  await expect(reset).toBeEnabled();
  state.error = "Mock Azure state could not be refreshed.";
  await page.getByRole("button", { name: "Refresh Azure state" }).click();
  await expect(reset).toBeDisabled();
  await expect(page.locator("#control-error")).toContainText(state.error);
  state.error = null;
  state.checkedAt = Date.now() / 1000 - 60;
  await page.getByRole("button", { name: "Refresh Azure state" }).click();
  await expect(reset).toBeDisabled();
  state.checkedAt = Date.now() / 1000;
  state.config = { ...MOCK_CONFIG, gatewayUrl: "https://other-gateway.example/contentunderstanding" };
  await page.getByRole("button", { name: "Refresh Azure state" }).click();
  await expect(reset).toBeDisabled();
  expect(cuCalls).toBe(0);
});
