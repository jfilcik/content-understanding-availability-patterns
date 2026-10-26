import test from "node:test";
import assert from "node:assert/strict";
import { Observatory } from "../client.js";
import { LocalControls } from "../controls.js";
import { MOCK_CONFIG, reply } from "./fixtures.js";

const config = MOCK_CONFIG;
const state = () => ({
  enabled: true, csrfToken: "synthetic-private-control-token",
  config,
  deployment: { gateway: { url: config.gatewayUrl } },
  leases: [],
});

test("local controls keep their token out of traces and submit only the supported action JSON", async () => {
  const app = new Observatory();
  app.configure(config);
  const requests = [];
  const controls = new LocalControls(app, {
    origin: "http://127.0.0.1:5174",
    fetcher: async (url, options) => {
      requests.push({ url, options });
      return reply(state());
    },
  });
  await controls.refresh();
  await controls.change("apply", { regionId: "gateway", kind: "threshold", thresholdSeconds: 5, durationSeconds: 300 });
  const change = requests.find((request) => request.options.method === "POST");
  assert.equal(change.options.headers["X-CU-Control-Token"], "synthetic-private-control-token");
  assert.equal(change.options.headers["Ocp-Apim-Subscription-Key"], undefined);
  assert.deepEqual(JSON.parse(change.options.body), { regionId: "gateway", kind: "threshold", thresholdSeconds: 5, durationSeconds: 300 });
  assert.ok(!JSON.stringify(app.requests).includes("synthetic-private-control-token"));
  assert.equal(controls.state.csrfToken, undefined);
  const entry = app.requests.find((request) => request.method === "POST");
  assert.equal(entry.regionId, "gateway");
  assert.equal(entry.controlKind, "threshold");
});

test("manual backend selection is explicit and controls require the exact helper gateway and CU identities", async () => {
  const app = new Observatory();
  app.configure(config);
  const controls = new LocalControls(app, {
    origin: "http://127.0.0.1:5174",
    fetcher: async () => reply(state()),
  });
  await controls.refresh();
  assert.equal(controls.matches(config), true);
  await controls.change("select", { backendId: "secondary-cu" });
  assert.ok(app.events[0].message.includes("manual steering"));
  assert.equal(controls.matches({ ...config, gatewayUrl: "https://foreign.example/api" }), false);
  assert.equal(controls.matches({ ...config, regions: [{ ...config.regions[0], region: "other" }, config.regions[1]] }), false);
  assert.equal(typeof controls.resolveRoute, "undefined");
});

test("local control errors surface explicitly and do not pretend changes succeeded", async () => {
  const app = new Observatory();
  const controls = new LocalControls(app, {
    origin: "http://127.0.0.1:5174",
    fetcher: async () => reply({ error: "Restoration blocked by concurrent edit." }, 409),
  });
  await assert.rejects(controls.change("restore", { regionId: "a", kind: "threshold" }), /concurrent edit/);
  assert.equal(controls.busy, false);
  assert.equal(app.requests[0].status, 409);
  assert.ok(!app.events.some((event) => event.type === "control"));
});
