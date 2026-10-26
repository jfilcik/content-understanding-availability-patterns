import { test, expect } from "@playwright/test";
import runTeachingGuide from "../../../tests/teaching-guide.browser.js";

test("OFFLINE GUIDE: maturity stages, navigation, playback and deployment handoff work together", async ({ page }) => {
  const externalRequests = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) externalRequests.push(request.url());
  });
  await page.goto(new URL("../../../README.html", import.meta.url).href);
  await expect(page.locator("#work-in-progress")).toBeVisible();
  await expect(page.locator("#work-in-progress")).toContainText("Work in progress (WIP).");
  const result = await runTeachingGuide(page);
  expect(result.passed).toBeGreaterThanOrEqual(45);
  expect(externalRequests).toEqual([]);
});
