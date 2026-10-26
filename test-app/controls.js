import { traceBody, traceValue } from "./core.js?v=8";

export class LocalControls {
  #token = "";
  constructor(observatory, { fetcher = (...args) => fetch(...args), origin = globalThis.location?.origin } = {}) {
    this.client = observatory;
    this.fetcher = fetcher;
    this.origin = origin;
    this.state = null;
    this.busy = false;
  }

  async request(path, body, { trace = true } = {}) {
    const url = this.origin + "/api/control/" + path;
    const method = body ? "POST" : "GET";
    const entry = trace ? this.client.recordRequest({
      url, method, kind: "Azure control",
      regionId: body?.regionId ?? null, controlKind: body?.kind ?? null,
      requestBody: body ? traceBody(body) : "",
      requestHeaders: body ? { "Content-Type": "application/json", "X-CU-Control-Token": "[redacted]" } : {},
    }) : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await this.fetcher(url, {
        method, credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: body ? { "Content-Type": "application/json", "X-CU-Control-Token": this.#token } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json();
      if (entry) this.client.finishRequest(entry, { status: response.status, responseBody: traceBody(payload) });
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `Local control returned HTTP ${response.status}.`);
      if (typeof payload.csrfToken === "string") this.#token = payload.csrfToken;
      const { csrfToken, ...state } = payload;
      return traceValue(state);
    } catch (error) {
      if (entry && entry.completedAt === null) this.client.finishRequest(entry, { error: "Local control request failed or timed out. Verify restoration status before retrying." });
      throw new Error(error.name === "AbortError"
        ? "Local control request timed out. Its outcome may be unknown; refresh restoration status, do not blindly repeat."
        : error.message);
    } finally { clearTimeout(timer); }
  }

  async refresh({ trace = true } = {}) {
    this.state = await this.request("state", undefined, { trace });
    return this.state;
  }

  matches(config) {
    return Boolean(this.state?.enabled && config && this.state.config.gatewayUrl === config.gatewayUrl
      && this.state.config.regions.every((region) => config.regions.some((candidate) =>
        candidate.id === region.id && candidate.region === region.region && candidate.backendId === region.backendId)));
  }

  async change(action, body) {
    if (this.busy) throw new Error("Wait for the current Azure control action to finish.");
    this.busy = true;
    try {
      await this.request(action, body);
      this.client.event("control", null, action === "select"
        ? `Backend selection requested: ${body.backendId}. This is manual steering, not automatic-failover evidence. Existing jobs remain pinned.`
        : action === "restore" ? "Threshold restoration requested. Active backend is unchanged; reset explicitly."
          : "Temporary gateway threshold requested. Observe runtime propagation; no analysis is submitted by this control.");
      return await this.refresh();
    } finally { this.busy = false; }
  }
}
