import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, LIMITS, configuredBackendUrl, decodeRoutingToken, duration, redactText,
  redactUrl, retryAfterMs, submissionUrl, validateConfig, validatePollingUrl,
} from "../core.js";
import { MOCK_CONFIG, pollUrl, routingToken, signedPollUrl } from "./fixtures.js";

export function config(overrides = {}) {
  return validateConfig({
    ...MOCK_CONFIG,
    ...overrides,
  });
}

test("configuration uses one APIM and two independent CU identities without DNS routing", () => {
  assert.deepEqual(config().analyzerIds, ["invoice", "receipt"]);
  assert.equal("healthUrl" in config(), false);
  assert.equal(submissionUrl(config().gatewayUrl, "invoice", "2025-11-01"), "https://gateway.example/contentunderstanding/analyzers/invoice:analyze?api-version=2025-11-01");
  assert.match(submissionUrl(config().gatewayUrl, "receipt", "2025-11-01", true), /receipt:analyzeBinary/);
});

test("config rejects credentials, HTTP, endpoint queries, duplicates, and fake global aliases", () => {
  for (const keyName of ["key", "apiKey", "subscriptionKey", "Ocp-Apim-Subscription-Key", "gateway-token", "password"]) {
    assert.throws(() => config({ [keyName]: "not-a-real-secret" }), /must not contain/);
  }
  for (const globalUrl of ["http://global.example/contentunderstanding", "https://u:p@global.example/api", "https://global.example/api?key=no", "https://global.example/api#frag", "https://a.example/contentunderstanding"]) {
    assert.throws(() => config({ globalUrl }));
  }
  assert.throws(() => config({ analyzerIds: ["invoice", "invoice"] }));
  for (const gatewayUrl of ["", "http://gateway.example/api", "https://gateway.example/api?key=no", "https://gateway.example/api#frag"]) {
    assert.throws(() => config({ gatewayUrl }));
  }
  assert.throws(() => config({ analyzerIds: ["../../evil"] }));
  assert.throws(() => config({ regions: [config().regions[0], config().regions[0]] }));
  assert.equal("healthUrl" in config({ healthUrl: "https://obsolete.example/health/cu" }), false);
  assert.throws(() => config({ globalUrl: "" }), /Obsolete/);
});

test("polling allowlist preserves the entire signed URL byte-for-byte", () => {
  const raw = "https://gateway.example/contentunderstanding/analyzerResults/op-01?api-version=2025-11-01&gateway-token=opaque%2Bvalue%2F%3D&other=a%20b&stamp=001";
  const checked = validatePollingUrl(raw, config());
  assert.equal(checked.url, raw);
  assert.equal(checked.operationId, "op-01");
  assert.equal(checked.region, undefined, "A shared hostname cannot establish CU identity.");
  assert.throws(() => validatePollingUrl(raw.replace("gateway.example", "b.example"), config()));
});

test("polling denies foreign origins, ports, paths, redirect targets, and credential URLs", () => {
  const invalid = [
    "http://a.example/contentunderstanding/analyzerResults/op?api-version=2025-11-01",
    "https://a.example.evil/contentunderstanding/analyzerResults/op?api-version=2025-11-01",
    "https://a.example:444/contentunderstanding/analyzerResults/op?api-version=2025-11-01",
    "https://a.example/other/analyzerResults/op?api-version=2025-11-01",
    "https://a.example/contentunderstanding/analyzers/invoice:analyze?api-version=2025-11-01",
    "https://a.example/contentunderstanding/analyzerResults/op/attachment?api-version=2025-11-01",
    "https://a.example/contentunderstanding/analyzerResults/op%2fescape?api-version=2025-11-01",
    "https://a.example/contentunderstanding/analyzerResults/op%5cescape?api-version=2025-11-01",
    "https://a.example/contentunderstanding/analyzerResults/%2e%2e?api-version=2025-11-01",
    "https://u:p@a.example/contentunderstanding/analyzerResults/op?api-version=2025-11-01",
    "https://a.example/contentunderstanding/analyzerResults/op?api-version=2025-11-01#secret",
    "https://a.example/contentunderstanding/analyzerResults/op",
    "https://a.example/contentunderstanding/analyzerResults/op?api-version=a&api-version=b",
    "https://a.example/contentunderstanding/analyzerResults/op?api-version=v&subscription-key=secret",
    "https://global.example/contentunderstanding/analyzerResults/op?api-version=2025-11-01",
  ];
  for (const url of invalid.map((url) => url.replace("a.example", "gateway.example"))) {
    assert.throws(() => validatePollingUrl(url, config()), undefined, url);
  }
});

test("custom single-gateway API roots retain exact paths without health endpoints", () => {
  const custom = config({ gatewayUrl: "https://gateway.example/custom/cu/" });
  assert.equal(validatePollingUrl("https://gateway.example/custom/cu/analyzerResults/op?api-version=2025-11-01&gateway-token=opaque", custom).operationId, "op");
  assert.throws(() => validatePollingUrl("https://gateway.example/contentunderstanding/analyzerResults/op?api-version=2025-11-01&gateway-token=opaque", custom));
});

test("Retry-After supports seconds and HTTP dates, never caps a long server delay early", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  assert.equal(retryAfterMs("10", now), 10_000);
  assert.equal(retryAfterMs("Mon, 19 Oct 2026 12:00:30 GMT", now), 30_000);
  assert.equal(retryAfterMs("3600", now), 3_600_000);
  for (const value of [null, "", "garbage", "0", "-1", "Mon, 19 Oct 2026 11:00:00 GMT"]) {
    assert.equal(retryAfterMs(value, now), LIMITS.pollIntervalMs);
  }
});

test("diagnostic redaction masks timing tokens and serving keys", () => {
  const shown = redactUrl("https://a.example/contentunderstanding/analyzerResults/op?api-version=2025-11-01&gateway-token=opaqueSecret&signature=signed&apiKey=hidden");
  assert.ok(shown.includes("api-version=2025-11-01"));
  assert.ok(!shown.includes("opaqueSecret"));
  assert.ok(!shown.includes("signed"));
  assert.ok(!shown.includes("hidden"));
  assert.equal(redactText("response leaked not-real-key and opaqueToken", ["not-real-key", "opaqueToken"]), "response leaked [redacted] and [redacted]");
  assert.equal(duration(65_000), "1m 5s");
});

test("routing inspection decodes both regions without claiming to verify the signature", () => {
  for (const [region, name] of [["a", "eastus"], ["b", "westus"]]) {
    const decoded = decodeRoutingToken(routingToken(region));
    assert.equal(decoded.error, null);
    assert.deepEqual(decoded.claims, {
      operation: "op-01", region: name, gateway: "apim-single", subscription: "mock-subscription-id",
      apiVersion: "2025-11-01", analyzer: "invoice", started: 1_790_000_000_000,
    });
    assert.deepEqual(Object.keys(decoded).sort(), ["claims", "error"]);
  }
  const [payload] = routingToken().split(".");
  assert.equal(decodeRoutingToken(`${payload}.${btoa("changed-unverified-signature")}`).claims.region, "eastus");
  assert.equal(decodeRoutingToken(routingToken("a", "op-01", { region: "unconfigured", extra: "<img src=x>" })).claims.extra, undefined);
});

test("routing inspection rejects opaque, malformed, oversized, and invalid routing claims explicitly", () => {
  const invalid = [
    null, {}, "x".repeat(4097), new URL(pollUrl()).searchParams.get("gateway-token"),
    "a.b.c", ".YQ==", "YQ==.", "%%%%.YQ==", `${btoa("not JSON")}.YQ==`, "/w==.YQ==",
    `${btoa("null")}.YQ==`, `${btoa("[]")}.YQ==`, `${btoa("{}")}.YQ==`,
    routingToken("a", "op", { started: -1 }), routingToken("a", "op", { started: "123" }),
    routingToken("a", "op", { started: 8_640_000_000_000_001 }),
    routingToken("a", "op", { region: "<img src=x onerror=alert(1)>" }),
    routingToken("a", "op", { operation: "../op" }),
    routingToken("a", "op", { subscription: null }),
  ];
  for (const value of invalid) {
    const decoded = decodeRoutingToken(value);
    assert.equal(decoded.claims, null);
    assert.ok(decoded.error, `Missing error for ${String(value)}`);
  }
});

test("backend URL illustrations map custom APIM roots and strip tokens without changing the actual poll URL", () => {
  const custom = config({ gatewayUrl: "https://gateway.example/custom/cu" });
  assert.equal(configuredBackendUrl(
    "https://gateway.example/custom/cu/analyzers/invoice:analyze?api-version=2025-11-01", custom, "https://cu-a.example/",
  ), "https://cu-a.example/contentunderstanding/analyzers/invoice:analyze?api-version=2025-11-01");
  const original = signedPollUrl("b");
  for (const endpoint of ["https://cu-a.example", "https://cu-b.example"]) {
    const shown = new URL(configuredBackendUrl(original, config(), endpoint));
    assert.equal(shown.origin, endpoint);
    assert.equal(shown.pathname, "/contentunderstanding/analyzerResults/op-01");
    assert.equal(shown.searchParams.get("api-version"), "2025-11-01");
    assert.equal(shown.searchParams.get("extra"), "opaque value");
    assert.equal(shown.searchParams.has("gateway-token"), false);
  }
  assert.equal(original, signedPollUrl("b"));
  const shown = configuredBackendUrl(original + "&signature=hidden", config(), "https://cu-b.example");
  assert.ok(!shown.includes("hidden"));
  for (const request of [
    original.replace("gateway.example", "foreign.example"), original.replace("contentunderstanding", "other"),
    original.replace("https:", "http:"),
  ]) assert.throws(() => configuredBackendUrl(request, config(), "https://cu-b.example"));
  for (const endpoint of ["http://cu-b.example", "https://cu-b.example?key=secret", "https://cu-b.example/#frag"]) {
    assert.throws(() => configuredBackendUrl(original, config(), endpoint));
  }
});
