import { DEFAULT_CONFIG, validateConfig } from "../core.js";

export const MOCK_KEY = "mock-serving-key-not-a-secret";
export const MOCK_CONFIG = validateConfig({
  ...DEFAULT_CONFIG,
  gatewayUrl: "https://gateway.example/contentunderstanding",
  regions: [
    { id: "a", label: "East", region: "eastus", backendId: "primary-cu" },
    { id: "b", label: "West", region: "westus", backendId: "secondary-cu" },
  ],
});
export const pollUrl = (region = "a", id = "op-01") =>
  `https://gateway.example/contentunderstanding/analyzerResults/${id}?api-version=2025-11-01&gateway-token=mock%2Btiming%2Ftoken%3D&extra=opaque%20value&fixture-region=${region}`;
export function routingToken(region = "a", operation = "op-01", overrides = {}) {
  const payload = {
    operation, region: region === "a" ? "eastus" : "westus", gateway: "apim-single",
    subscription: "mock-subscription-id", apiVersion: "2025-11-01", analyzer: "invoice",
    started: 1_790_000_000_000, ...overrides,
  };
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))));
  return `${encoded}.${btoa("mock-signature-not-verified")}`;
}
export function signedPollUrl(region = "a", id = "op-01", overrides = {}) {
  const url = new URL(pollUrl(region, id));
  url.searchParams.set("gateway-token", routingToken(region, id, overrides));
  return url.href;
}
export function reply(body = "", status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

export class Clock {
  now = 1_000_000;
  timers = new Map();
  sequence = 0;
  setTimer = (fn, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.now + delay, fn });
    return id;
  };
  clearTimer = (id) => { this.timers.delete(id); };
  async advance(ms) {
    const target = this.now + ms;
    let count = 0;
    while (true) {
      const [id, timer] = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!timer || timer.at > target) break;
      if (++count > 1_000) throw new Error("Timer runaway in mocked clock.");
      this.now = timer.at;
      this.timers.delete(id);
      timer.fn();
      await new Promise(setImmediate);
    }
    this.now = target;
    await new Promise(setImmediate);
  }
}
