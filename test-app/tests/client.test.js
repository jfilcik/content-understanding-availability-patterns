import test from "node:test";
import assert from "node:assert/strict";
import { Observatory } from "../client.js";
import { LIMITS } from "../core.js";
import { Clock, MOCK_CONFIG, MOCK_KEY, pollUrl, reply, routingToken, signedPollUrl } from "./fixtures.js";

function harness(handler) {
  const clock = new Clock();
  const calls = [];
  const app = new Observatory({
    now: () => clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return handler(url, options, calls);
    },
  });
  app.configure(MOCK_CONFIG);
  app.setKey(MOCK_KEY);
  return { app, clock, calls };
}
const submit = (app, extra = {}) => app.submit({ analyzerId: "invoice", documentUrl: "https://documents.example/private-invoice.pdf?sig=private-document-token", ...extra });
const accepted = (region = "a", id = "op-01", extra = {}) => reply("", 202, {
  "Operation-Location": pollUrl(region, id),
  "X-CU-Region": region === "a" ? "eastus" : "westus",
  "X-CU-Gateway": "apim-single", "X-CU-Backend": region === "a" ? "primary-cu" : "secondary-cu",
  "Retry-After": "3", ...extra,
});

test("MOCK: JSON submit sends inputs; full signed regional URL is pinned across pending to success", async () => {
  let gets = 0;
  const { app, clock, calls } = harness((url, options) => options.method === "POST"
    ? accepted()
    : reply({ status: ++gets === 1 ? "running" : "Succeeded", result: { text: "private result" } }, 200, { "X-CU-Elapsed-Seconds": "64.2", "X-CU-Region": "eastus" }));
  const job = await submit(app);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body), { inputs: [{ url: "https://documents.example/private-invoice.pdf?sig=private-document-token" }] });
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
  await clock.advance(3_000);
  assert.equal(job.status, "Running");
  assert.equal(calls[1].url, pollUrl());
  assert.equal(calls[1].options.headers["Ocp-Apim-Subscription-Key"], MOCK_KEY);
  await clock.advance(3_000);
  assert.equal(job.status, "Succeeded");
  assert.equal(job.pollCount, 2);
  assert.equal(job.gatewayElapsed, 64.2);
  assert.equal(job.terminal, true);
  assert.equal(job.monitoring, false);
  assert.ok(!JSON.stringify(app.events).includes("private-invoice"));
  assert.ok(!JSON.stringify(app.events).includes("private result"));
  assert.ok(!JSON.stringify(app.events).includes("timing"));
  assert.ok(!JSON.stringify(app.events).includes(MOCK_KEY));
});

test("MOCK: request trace captures individual POST/GET evidence without retaining keys or signed query secrets", async () => {
  const { app, clock } = harness((url, options) => options.method === "POST"
    ? accepted()
    : reply({ status: "Running", result: { token: "mock+timing/token=", echoed: MOCK_KEY } }, 200, { "X-CU-Elapsed-Seconds": "6.5" }));
  await submit(app);
  await clock.advance(3_000);
  assert.equal(app.requests.length, 2);
  const [post, poll] = app.requests;
  assert.equal(post.kind, "Analyze");
  assert.equal(post.status, 202);
  assert.equal(post.regionId, "a");
  assert.equal(post.requestHeaders["Ocp-Apim-Subscription-Key"], "[redacted]");
  assert.match(post.requestBody, /private-invoice.pdf/);
  assert.ok(!post.requestBody.includes("private-document-token"));
  assert.equal(poll.kind, "Poll result");
  assert.equal(poll.jobId, "job-001");
  assert.equal(poll.status, 200);
  assert.equal(poll.gatewayElapsed, 6.5);
  assert.equal(poll.cuStatus, "Running");
  const trace = JSON.stringify(app.requests);
  for (const secret of [MOCK_KEY, "mock+timing/token=", "mock%2Btiming%2Ftoken%3D", "private-document-token"]) {
    assert.ok(!trace.includes(secret), `Trace leaked ${secret}`);
  }
  app.clearKey();
  assert.ok(!JSON.stringify(app.requests).includes(MOCK_KEY));
});

test("MOCK: selected-response ID, status, backend and new-work selection remain historical across later polls", async () => {
  const { app, clock } = harness((url, options) => {
    const post = options.method === "POST";
    return reply({
      id: "cu-operation-01", status: post ? "Running" : "Succeeded",
      result: { contents: "x".repeat(LIMITS.maxTraceBodyChars + 20) },
    }, post ? 202 : 200, {
      ...(post ? { "Operation-Location": pollUrl("b", "cu-operation-01") } : {}),
      "X-CU-Region": "westus", "X-CU-Backend": "secondary-cu",
      "X-CU-Active-Backend": post ? "secondary-cu" : "primary-cu",
    });
  });
  const job = await submit(app);
  await clock.advance(3_000);
  const [post, poll] = app.requests;
  assert.equal(job.status, "Succeeded");
  assert.equal(post.responseId, "cu-operation-01");
  assert.equal(post.cuStatus, "Running");
  assert.equal(post.reportedBackend, "secondary-cu");
  assert.equal(post.activeBackend, "secondary-cu");
  assert.equal(poll.responseId, "cu-operation-01");
  assert.equal(poll.cuStatus, "Succeeded");
  assert.equal(poll.reportedBackend, "secondary-cu");
  assert.equal(poll.activeBackend, "primary-cu");
  assert.ok(post.responseBody.length < LIMITS.maxTraceBodyChars + 100);
  assert.equal(job.pinnedRegion.id, "b");
});

test("MOCK: deliberate token inspection does not add full tokens to traces or bypass key clearing", async () => {
  const { app } = harness(() => accepted("b", "op-inspection", { "Operation-Location": signedPollUrl("b", "op-inspection") }));
  const job = await submit(app);
  assert.equal(app.getInspectionToken(job.id), routingToken("b", "op-inspection"));
  assert.ok(!JSON.stringify(app.requests).includes(routingToken("b", "op-inspection")));
  assert.ok(!JSON.stringify(app.events).includes(routingToken("b", "op-inspection")));
  app.clearKey();
  assert.equal(app.getInspectionToken(job.id), null);
  app.setKey(MOCK_KEY);
  assert.equal(app.getInspectionToken(job.id), routingToken("b", "op-inspection"));
});

test("MOCK: metadata and deliberate token inspection cannot expose an echoed serving key", async () => {
  const { app } = harness(() => accepted("a", "op", {
    "Operation-Location": pollUrl().replace("mock%2Btiming%2Ftoken%3D", encodeURIComponent(MOCK_KEY)),
  }));
  const job = await submit(app);
  assert.equal(app.getInspectionToken(job.id), "[redacted]");
  const echoed = harness(() => reply({ id: MOCK_KEY, status: "Running" }, 202, {
    "X-CU-Region": MOCK_KEY, "X-CU-Backend": MOCK_KEY, "X-CU-Active-Backend": MOCK_KEY,
  })).app;
  await submit(echoed);
  assert.ok(!JSON.stringify(echoed.requests).includes(MOCK_KEY));
  for (const field of ["responseId", "reportedRegion", "reportedBackend", "activeBackend"]) {
    assert.equal(echoed.requests[0][field], "not reported");
  }
});

test("MOCK: backend changes use the same APIM; client-side regional and DNS steering are rejected", async () => {
  let posts = 0;
  const { app, clock, calls } = harness((url, options) => options.method === "POST"
    ? accepted(++posts === 1 ? "a" : "b", `op-${posts}`)
    : reply({ status: "Running" }));
  const first = await submit(app);
  await submit(app);
  await clock.advance(3_000);
  assert.equal(first.pollUrl, pollUrl("a", "op-1"));
  assert.deepEqual(calls.filter((call) => call.options.method === "POST").map((call) => new URL(call.url).hostname), ["gateway.example", "gateway.example"]);
  assert.ok(app.events.some((event) => event.type === "steering" && event.message.includes("same APIM")));
  await assert.rejects(submit(app, { target: "dns" }), /single APIM/);
  await assert.rejects(submit(app, { target: "a" }), /single APIM/);
});

test("MOCK: request trace is bounded; clearing it retains in-flight observations and never changes jobs", async () => {
  const { app } = harness(() => accepted());
  const job = await submit(app);
  for (let i = 0; i < LIMITS.maxRequests + 10; i++) {
    const entry = app.recordRequest({ url: "http://127.0.0.1/api/control/state", kind: "Azure control" });
    app.finishRequest(entry, { status: 200 });
  }
  assert.equal(app.requests.length, LIMITS.maxRequests);
  const active = app.recordRequest({ url: "http://127.0.0.1/api/control/state", kind: "Azure control" });
  app.clearRequests();
  assert.deepEqual(app.requests, [active]);
  assert.equal(app.jobs[0], job);
  assert.ok(job.monitoring);
});

test("MOCK: failed HTTP transport has a trace row without replaying an uncertain POST", async () => {
  const { app, calls } = harness(() => { throw new Error("private network exception"); });
  await submit(app);
  assert.equal(calls.length, 1);
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].status, null);
  assert.ok(app.requests[0].error.includes("not automatically replayed"));
  assert.ok(!JSON.stringify(app.requests).includes("private network exception"));
});

test("MOCK: analyzeBinary sends the exact Blob through APIM and records the reported CU backend", async () => {
  const { app, calls } = harness(() => accepted("b"));
  const file = new Blob(["mock document contents"], { type: "application/pdf" });
  const job = await app.submit({ analyzerId: "receipt", file });
  assert.match(calls[0].url, /^https:\/\/gateway\.example\/contentunderstanding\/analyzers\/receipt:analyzeBinary\?/);
  assert.equal(calls[0].options.headers["Content-Type"], "application/pdf");
  assert.equal(calls[0].options.body, file);
  assert.equal(job.pinnedRegion.id, "b");
  assert.match(app.events.find((event) => event.type === "submit").message, /APIM selects/);
});

test("MOCK: unsafe accepted Operation-Location never receives credentials or a GET", async () => {
  for (const location of [
    "https://evil.example/contentunderstanding/analyzerResults/op?api-version=v",
    "https://a.example/not-the-api/op?api-version=v",
    "https://a.example/contentunderstanding/analyzerResults/op?api-version=v#fragment",
  ]) {
    const { app, clock, calls } = harness(() => accepted("a", "op", { "Operation-Location": location }));
    const job = await submit(app);
    await clock.advance(120_000);
    assert.equal(calls.length, 1);
    assert.equal(job.pollUrl, null);
    assert.equal(job.status, "Accepted · polling blocked");
    assert.match(job.error, /may still be running/);
  }
});

test("MOCK: stop/resume preserves Retry-After and never replays POST", async () => {
  const { app, clock, calls } = harness((url, options) => options.method === "POST"
    ? accepted("a", "op", { "Retry-After": "10" })
    : reply({ status: "Running" }, 200, { "Retry-After": "20" }));
  const job = await submit(app);
  app.stop(job.id);
  await clock.advance(5_000);
  app.resume(job.id);
  await clock.advance(4_999);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(job.pollCount, 1);
  app.stop(job.id);
  app.resume(job.id);
  await clock.advance(19_999);
  assert.equal(job.pollCount, 1);
  await clock.advance(1);
  assert.equal(job.pollCount, 2);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
});

test("MOCK: two global jobs can switch regions while the original remains pinned", async () => {
  let posts = 0;
  const { app, clock, calls } = harness((url, options) => options.method === "POST"
    ? accepted(++posts === 1 ? "a" : "b", `op-${posts}`)
    : reply({ status: "NotStarted" }));
  const first = await submit(app);
  const second = await submit(app);
  await clock.advance(3_000);
  assert.equal(first.pinnedRegion.id, "a");
  assert.equal(second.pinnedRegion.id, "b");
  assert.equal(calls.filter((call) => call.options.method === "GET" && call.url === pollUrl("a", "op-1")).length, 1);
  assert.equal(calls.filter((call) => call.options.method === "GET" && call.url === pollUrl("b", "op-2")).length, 1);
  assert.ok(app.events.some((event) => event.type === "steering" && event.message.includes("not just management")));
});

test("MOCK: a degraded submission is rejected once; existing result GETs still run", async () => {
  let posts = 0;
  const { app, clock, calls } = harness((url, options) => {
    if (options.method === "POST") return ++posts === 1 ? accepted() : reply({ error: "cooldown" }, 503, { "Retry-After": "300", "X-CU-Region": "eastus" });
    return reply({ status: "Running" });
  });
  const first = await submit(app);
  const rejected = await submit(app);
  assert.equal(rejected.status, "Rejected · 503");
  await clock.advance(3_000);
  assert.equal(first.status, "Running");
  assert.equal(first.pollCount, 1);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 2);
});

test("MOCK: failed CU result is terminal, not recorded as success", async () => {
  const { app, clock } = harness((url, options) => options.method === "POST"
    ? accepted() : reply({ status: "FAILED", error: { code: "InvalidDocument" } }));
  const job = await submit(app);
  await clock.advance(3_000);
  assert.equal(job.status, "Failed");
  assert.equal(job.terminal, true);
  assert.ok(!app.events.some((event) => event.message.startsWith("Succeeded")));
});

test("MOCK: HTTP polling Retry-After is respected and authentication errors pause", async () => {
  let polls = 0;
  const { app, clock, calls } = harness((url, options) => options.method === "POST" ? accepted()
    : ++polls === 1 ? reply({}, 429, { "Retry-After": "12" }) : reply({}, 403));
  const job = await submit(app);
  await clock.advance(3_000);
  await clock.advance(11_999);
  assert.equal(job.pollCount, 1);
  await clock.advance(1);
  assert.equal(job.pollCount, 2);
  assert.equal(job.monitoring, false);
  assert.match(job.error, /HTTP 403/);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
});

test("MOCK: long Retry-After pauses at the monitoring budget rather than polling early", async () => {
  const { app, clock, calls } = harness(() => accepted("a", "op", { "Retry-After": "3600" }));
  const job = await submit(app);
  assert.equal(job.monitoring, false);
  app.resume(job.id);
  await clock.advance(10_000);
  assert.equal(calls.length, 1);
  assert.match(job.error, /budget/);
});

test("MOCK: polling is bounded to 120 attempts; deliberate resume continues GETs only", async () => {
  const { app, clock, calls } = harness((url, options) => options.method === "POST" ? accepted() : reply({ status: "Running" }));
  const job = await submit(app);
  await clock.advance(LIMITS.maxPolls * LIMITS.pollIntervalMs);
  assert.equal(job.pollCount, 120);
  assert.equal(job.monitoring, false);
  app.resume(job.id);
  await clock.advance(LIMITS.pollIntervalMs);
  assert.equal(job.pollCount, 121);
  assert.equal(calls.filter((call) => call.options.method === "POST").length, 1);
});

test("MOCK: retained polling URL resumes GET only with unknown original age", async () => {
  const { app, clock, calls } = harness(() => reply({ status: "Succeeded" }));
  const job = app.retainPollingUrl(pollUrl("b"));
  await clock.advance(0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(job.resumedOrigin, true);
  assert.equal(job.status, "Succeeded");
  assert.throws(() => app.retainPollingUrl("https://evil.example/operation"), /blocked/);
});

test("MOCK: clearing in-memory credentials aborts monitoring and requires a fresh key to resume", async () => {
  const { app, clock, calls } = harness(() => accepted());
  const job = await submit(app);
  app.clearKey();
  await clock.advance(30_000);
  assert.equal(app.hasKey, false);
  assert.equal(job.monitoring, false);
  assert.equal(calls.length, 1);
  assert.throws(() => app.resume(job.id), /key/);
  assert.throws(() => app.configure(MOCK_CONFIG), /locked/);
});

test("MOCK: redirect outcomes and POST network failures are never automatically retried", async () => {
  for (const response of [reply("", 302, { Location: "https://evil.example" }), null]) {
    const { app, clock, calls } = harness(() => {
      if (!response) throw new TypeError("Mock network failure with sensitive URL");
      return response;
    });
    const job = await submit(app);
    await clock.advance(120_000);
    assert.equal(job.status, "Submission outcome unknown");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, "error");
  }
});

test("MOCK: configuration and idle time send no synthetic health requests", async () => {
  const { app, clock, calls } = harness(() => { throw new Error("Unexpected background probe"); });
  await clock.advance(120_000);
  assert.equal(calls.length, 0);
  assert.equal(app.gatewayObservation, null);
  assert.equal(app.refreshHealth, undefined);
  assert.equal(app.refreshAllHealth, undefined);
});

test("MOCK: runtime observation comes only from real POST/result headers and survives clearing the trace", async () => {
  const { app, clock, calls } = harness((url, options) => options.method === "POST"
    ? accepted("a", "op-01", { "X-CU-Active-Backend": "primary-cu", "X-CU-Latency-Threshold-Seconds": "60" })
    : reply({ status: "Succeeded" }, 200, {
      "X-CU-Active-Backend": "secondary-cu", "X-CU-Latency-Threshold-Seconds": "2",
      "X-CU-Elapsed-Seconds": "65.5", "X-CU-Trigger": "operation-duration",
      "X-CU-Degradation-Reason": "completion-latency", "X-CU-Switch-Status": "accepted-awaiting-activation",
    }));
  const job = await submit(app);
  assert.equal(app.gatewayObservation.activeBackend, "primary-cu");
  await clock.advance(3_000);
  assert.equal(job.gatewayElapsed, 65.5);
  assert.equal(job.status, "Succeeded");
  assert.equal(app.gatewayObservation.activeBackend, "secondary-cu");
  assert.equal(app.gatewayObservation.thresholdSeconds, 2);
  assert.equal(app.gatewayObservation.checkedAt, clock.now);
  assert.equal(app.gatewayObservation.trigger, "operation-duration");
  assert.equal(app.requests[1].degradationReason, "completion-latency");
  assert.equal(calls.length, 2);
  app.clearRequests();
  assert.equal(app.gatewayObservation.activeBackend, "secondary-cu");
  assert.equal(job.pinnedRegion.backendId, "primary-cu");
});

test("MOCK: missing or invalid response metadata does not fabricate runtime selection or threshold", async () => {
  for (const headers of [{}, { "X-CU-Active-Backend": "other-backend", "X-CU-Latency-Threshold-Seconds": "NaN" },
    { "X-CU-Latency-Threshold-Seconds": "-1" }, { "X-CU-Latency-Threshold-Seconds": " " }]) {
    const { app } = harness(() => accepted("a", "op-01", headers));
    await submit(app);
    assert.equal(app.gatewayObservation.activeBackend, null);
    assert.equal(app.gatewayObservation.thresholdSeconds, null);
  }
});

test("MOCK: raw results are isolated from timeline and displayed secrets are redacted", async () => {
  const { app, clock } = harness((url, options) => options.method === "POST" ? accepted()
    : reply({ status: "Succeeded", result: { leakedKey: MOCK_KEY, leakedToken: "mock+timing/token=", document: "<img src=x onerror=alert(1)>" } }));
  const job = await submit(app);
  await clock.advance(3_000);
  const safe = app.safe(JSON.stringify(job.result));
  assert.ok(!safe.includes(MOCK_KEY));
  assert.ok(!safe.includes("mock+timing/token="));
  assert.ok(!JSON.stringify(app.events).includes("onerror"));
  assert.ok(!app.getDisplayUrl(job).includes("mock%2Btiming"));
  app.clearKey();
  assert.ok(!app.safe(JSON.stringify(job.result)).includes(MOCK_KEY), "clearing the key cannot expose an echoed credential");
  assert.ok(!JSON.stringify(job.result).includes(MOCK_KEY), "redaction happens before retaining result data");
});

test("MOCK: request timeout pauses pinned polling without replaying the POST", async () => {
  const { app, clock, calls } = harness((url, options) => options.method === "POST" ? accepted()
    : new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Mock request aborted")))));
  const job = await submit(app);
  await clock.advance(3_000 + LIMITS.requestTimeoutMs);
  assert.equal(job.monitoring, false);
  assert.match(job.error, /timeout/);
  assert.equal(calls.length, 2);
  assert.equal(job.pollCount, 1);
});

test("MOCK: stopping an in-flight GET ignores late terminal responses and keeps the same URL for resume", async () => {
  let finish;
  const { app, clock } = harness((url, options) => options.method === "POST" ? accepted()
    : new Promise((resolve) => { finish = resolve; }));
  const job = await submit(app);
  await clock.advance(3_000);
  assert.equal(job.pollCount, 1);
  app.stop(job.id);
  finish(reply({ status: "Succeeded" }));
  await clock.advance(0);
  assert.equal(job.status, "Accepted");
  assert.equal(job.terminal, false);
  assert.equal(job.monitoring, false);
  assert.equal(job.pollUrl, pollUrl());
});

test("MOCK: malformed JSON or unknown CU statuses pause instead of inventing a completion", async () => {
  for (const result of ["not JSON", { status: "unexpected" }, { result: "no status" }]) {
    const { app, clock } = harness((url, options) => options.method === "POST" ? accepted() : reply(result));
    const job = await submit(app);
    await clock.advance(3_000);
    assert.equal(job.monitoring, false);
    assert.equal(job.terminal, false);
    assert.match(job.error, /no supported CU operation status/);
  }
});

test("MOCK: accepting region stays distinguishable from the latest polling response identity", async () => {
  const { app, clock } = harness((url, options) => options.method === "POST" ? accepted()
    : reply({ status: "Running" }, 200, { "X-CU-Region": "reported-different-region" }));
  const job = await submit(app);
  await clock.advance(3_000);
  assert.equal(job.acceptedRegion, "eastus");
  assert.equal(job.reportedRegion, "reported-different-region");
  assert.equal(job.pinnedRegion.id, "a");
});

test("MOCK: pause/resume during an in-flight GET cannot bypass the minimum polling cadence", async () => {
  let gets = 0;
  const { app, clock, calls } = harness((url, options) => {
    if (options.method === "POST") return accepted();
    if (++gets > 1) return reply({ status: "Running" });
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Mock aborted"))));
  });
  const job = await submit(app);
  await clock.advance(3_000);
  app.stop(job.id);
  app.resume(job.id);
  await clock.advance(2_999);
  assert.equal(calls.length, 2);
  await clock.advance(1);
  assert.equal(calls.length, 3);
  assert.equal(job.status, "Running");
});
