import {
  LIMITS, redactText, redactUrl, redactValue, retryAfterMs,
  safeIdentity, submissionUrl, validateConfig, validatePollingUrl,
  traceBody, traceValue,
} from "./core.js?v=8";

export class Observatory {
  #key = "";
  #fetch;
  #now;
  #setTimer;
  #clearTimer;
  #onChange;
  #previousGlobalRegion = null;
  #requestSequence = 0;

  constructor({
    fetcher = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
    onChange = () => {},
  } = {}) {
    this.#fetch = fetcher;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#onChange = onChange;
    this.config = null;
    this.jobs = [];
    this.events = [];
    this.gatewayObservation = null;
    this.requests = [];
  }

  configure(input) {
    if (this.jobs.length) throw new Error("Connection settings are locked while jobs exist. Reload to change endpoints; retain polling URLs first.");
    this.config = validateConfig(input);
    this.gatewayObservation = null;
    this.#previousGlobalRegion = null;
    this.event("configuration", null, "One APIM configured for both CU backends. New work follows active selection; results retain signed backend affinity.");
  }

  setKey(value) {
    if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value)) throw new Error("Enter a valid APIM serving subscription key.");
    this.#key = value.trim();
    this.#onChange();
  }

  clearKey() {
    this.#key = "";
    for (const job of this.jobs) this.stop(job.id, "Credential cleared. Monitoring stopped; CU work is not cancelled.");
    this.#onChange();
  }

  get hasKey() { return Boolean(this.#key); }

  safe(value) {
    const secrets = [this.#key];
    for (const job of this.jobs) {
      if (!job.pollUrl) continue;
      for (const [name, token] of new URL(job.pollUrl).searchParams) {
        if (/token|signature|secret/i.test(name)) secrets.push(token, encodeURIComponent(token));
      }
    }
    return redactText(value, secrets);
  }

  event(type, job, message) {
    this.events.unshift({ time: this.#now(), type, jobId: job?.id ?? null, message: this.safe(message) });
    if (this.events.length > LIMITS.maxEvents) this.events.length = LIMITS.maxEvents;
    this.#onChange();
  }

  #requireConnection() {
    if (!this.config) throw new Error("Apply connection settings first.");
    if (!this.#key) throw new Error("Enter the runtime APIM subscription key first.");
  }

  recordRequest({ url, method = "GET", kind, jobId = null, regionId = null, controlKind = null, requestHeaders = {}, requestBody = "" }) {
    const entry = {
      id: `req-${String(++this.#requestSequence).padStart(4, "0")}`,
      url: redactUrl(url), method, kind, jobId, regionId, controlKind,
      startedAt: this.#now(), completedAt: null, rtt: null, status: null, error: null,
      requestHeaders: traceValue(requestHeaders), requestBody,
      responseHeaders: {}, responseBody: "", cuStatus: "", responseId: "",
      gatewayElapsed: null, reportedRegion: "", reportedBackend: "", activeBackend: "",
      thresholdSeconds: null, degradationReason: "",
    };
    this.requests.push(entry);
    if (this.requests.length > LIMITS.maxRequests) this.requests.shift();
    this.#onChange();
    return entry;
  }

  finishRequest(entry, fields) {
    Object.assign(entry, fields, { completedAt: this.#now(), rtt: Math.max(0, this.#now() - entry.startedAt) });
    this.#onChange();
  }

  clearRequests() {
    this.requests = this.requests.filter((entry) => entry.completedAt === null);
    this.#onChange();
  }

  async #request(url, options, controller, metadata) {
    const started = this.#now();
    const secrets = [options.headers?.["Ocp-Apim-Subscription-Key"]];
    for (const [name, value] of new URL(url).searchParams) {
      if (/token|signature|secret|key/i.test(name)) secrets.push(value, encodeURIComponent(value));
    }
    let preview = options.body || "";
    if (typeof preview === "string") {
      try { preview = JSON.parse(preview); } catch { /* A textual request preview is also valid. */ }
    } else preview = `[Binary body: ${preview.size} bytes; ${options.headers?.["Content-Type"] || "application/octet-stream"}]`;
    const entry = this.recordRequest({
      url, ...metadata, method: options.method,
      requestHeaders: traceValue(options.headers || {}, secrets),
      requestBody: traceBody(preview, secrets),
    });
    const timeout = this.#setTimer(() => controller.abort(), LIMITS.requestTimeoutMs);
    try {
      const response = await this.#fetch(url, {
        ...options,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      // Defense in depth for custom fetch adapters; browsers reject redirects before following them.
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new Error("Redirects are not permitted.");
      }
      const raw = await response.text();
      let payload = null;
      try { payload = raw ? redactValue(JSON.parse(raw), secrets) : null; } catch { /* Contract checked by each caller. */ }
      const text = redactText(raw, secrets);
      let observedRegion = metadata?.regionId ?? null;
      const identity = this.config?.regions.find((region) => region.region === response.headers.get("X-CU-Region")
        && (!response.headers.get("X-CU-Backend") || region.backendId === response.headers.get("X-CU-Backend")));
      if (identity) observedRegion = identity.id;
      const elapsed = response.headers.get("X-CU-Elapsed-Seconds");
      const threshold = response.headers.get("X-CU-Latency-Threshold-Seconds");
      const responseIdentity = (value) => safeIdentity(typeof value === "string" ? redactText(value, secrets) : "");
      this.finishRequest(entry, {
        status: response.status, regionId: observedRegion,
        responseHeaders: traceValue(Object.fromEntries(response.headers), secrets),
        responseBody: traceBody(payload ?? text, secrets),
        cuStatus: safeIdentity(payload?.status || ""),
        responseId: safeIdentity(payload?.id),
        reportedRegion: responseIdentity(response.headers.get("X-CU-Region")),
        reportedBackend: responseIdentity(response.headers.get("X-CU-Backend")),
        activeBackend: responseIdentity(response.headers.get("X-CU-Active-Backend")),
        gatewayElapsed: elapsed?.trim() && Number.isFinite(Number(elapsed)) && Number(elapsed) >= 0 ? Number(elapsed) : null,
        thresholdSeconds: threshold?.trim() && Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : null,
        degradationReason: responseIdentity(response.headers.get("X-CU-Degradation-Reason")),
      });
      if (["Analyze", "Poll result"].includes(entry.kind)) {
        this.gatewayObservation = {
          checkedAt: entry.completedAt, requestId: entry.id, kind: entry.kind, status: entry.status,
          activeBackend: this.config.regions.some((region) => region.backendId === entry.activeBackend) ? entry.activeBackend : null,
          thresholdSeconds: entry.thresholdSeconds,
          gateway: responseIdentity(response.headers.get("X-CU-Gateway")),
          trigger: responseIdentity(response.headers.get("X-CU-Trigger")),
          switchStatus: responseIdentity(response.headers.get("X-CU-Switch-Status")),
        };
      }
      return { response, payload, text, rtt: Math.max(0, this.#now() - started) };
    } catch (error) {
      this.finishRequest(entry, { error: "Network / CORS / TLS / timeout / rejected redirect. The request was not automatically replayed." });
      throw error;
    } finally {
      this.#clearTimer(timeout);
    }
  }

  async submit({ target = "gateway", analyzerId, documentUrl, file }) {
    this.#requireConnection();
    if (!this.config.analyzerIds.includes(analyzerId)) throw new Error("Choose a configured analyzer.");
    if (target !== "gateway") throw new Error("Only the configured single APIM submission route is supported.");
    const endpoint = this.config.gatewayUrl;
    if (file && documentUrl) throw new Error("Choose a document URL or a file, not both.");
    let body;
    let contentType;
    if (file) {
      if (!file.size) throw new Error("Choose a non-empty file.");
      body = file;
      contentType = file.type || "application/octet-stream";
    } else {
      let url;
      try { url = new URL(documentUrl); } catch { throw new Error("Provide an absolute HTTPS document URL or choose a file."); }
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Document URLs must use HTTPS without embedded credentials.");
      body = JSON.stringify({ inputs: [{ url: documentUrl }] });
      contentType = "application/json";
    }
    const job = {
      id: `job-${String(this.jobs.length + 1).padStart(3, "0")}`,
      analyzerId, target, endpoint, createdAt: this.#now(), acceptedAt: null,
      status: "Submitting", monitoring: false, pollCount: 0, sessionPolls: 0,
      lastRtt: null, gatewayElapsed: null, pollUrl: null, pinnedRegion: null,
      acceptedRegion: "not reported", reportedRegion: "not reported", gateway: "not reported", operationId: null,
      nextPollAt: 0, result: null, error: null, endedAt: null, terminal: false,
      generation: 0, timer: null, controller: new AbortController(),
    };
    this.jobs.unshift(job);
    this.event("submit", job, `POST sent to ${new URL(endpoint).host}. APIM selects the active CU backend; the browser does not select a region.`);
    try {
      const requestKey = this.#key;
      const { response, payload, text, rtt } = await this.#request(
        submissionUrl(endpoint, analyzerId, this.config.apiVersion, Boolean(file)),
        { method: "POST", headers: { "Ocp-Apim-Subscription-Key": requestKey, "Content-Type": contentType }, body },
        job.controller,
        { kind: "Analyze", jobId: job.id },
      );
      job.lastRtt = rtt;
      job.acceptedRegion = safeIdentity(redactText(response.headers.get("X-CU-Region") || "", [requestKey]));
      job.reportedRegion = job.acceptedRegion;
      job.gateway = safeIdentity(redactText(response.headers.get("X-CU-Gateway") || "", [requestKey]));
      if (response.status !== 202) {
        job.status = response.status === 503 ? "Rejected · 503" : `Submission HTTP ${response.status}`;
        job.result = payload ?? text;
        job.error = payload?.error?.code === "GatewayNotConfigured"
          ? "Gateway/analyzer provisioning is incomplete. Finish deployment before a deliberate new submission. No automatic resubmission."
          : response.status === 503
          ? `Gateway rejected new work. Retry-After: ${redactText(response.headers.get("Retry-After") || "not reported", [requestKey])}. No automatic resubmission.`
          : "Submission did not return HTTP 202. No automatic resubmission.";
        job.terminal = true;
        job.endedAt = this.#now();
        this.event("rejected", job, `${job.status}; gateway region ${job.reportedRegion}. POST will not be replayed.`);
        return job;
      }
      job.acceptedAt = this.#now();
      job.status = "Accepted";
      const location = response.headers.get("Operation-Location");
      try {
        const validated = validatePollingUrl(location, this.config);
        job.pollUrl = validated.url;
        job.pinnedRegion = this.config.regions.find((region) => region.region === response.headers.get("X-CU-Region")
          && (!response.headers.get("X-CU-Backend") || region.backendId === response.headers.get("X-CU-Backend")));
        if (!job.pinnedRegion) throw new Error("No valid accepting-backend identity.");
        job.operationId = validated.operationId;
      } catch {
        job.status = "Accepted · polling blocked";
        job.pollUrl = null;
        job.error = "Analysis was accepted, but its polling URL or accepting CU identity is missing, hidden by CORS, or untrusted. Work may still be running. Do not resubmit automatically.";
        this.event("blocked", job, "Accepted POST has no safe regional polling URL. No credentialed GET was sent.");
        return job;
      }
      this.event("accepted", job, `Accepted by ${job.pinnedRegion.label} (${job.reportedRegion}); signed polling stays on that CU through ${new URL(job.pollUrl).host}.`);
      if (target === "gateway") {
        if (this.#previousGlobalRegion && this.#previousGlobalRegion !== job.pinnedRegion.id) {
          this.event("steering", job, `A new request through the same APIM was accepted in ${job.pinnedRegion.label}. Older jobs stay pinned. This is response evidence, not just management configuration.`);
        }
        this.#previousGlobalRegion = job.pinnedRegion.id;
      }
      job.nextPollAt = this.#now() + retryAfterMs(response.headers.get("Retry-After"), this.#now());
      if (this.#key) this.resume(job.id);
      else job.error = "Credential was cleared while the POST was in flight. Accepted work is retained; set a key and resume monitoring.";
      return job;
    } catch {
      job.status = "Submission outcome unknown";
      job.error = "The request failed or timed out (network, CORS, TLS, redirect, or abort). The POST may have been accepted. It is never replayed; use a retained polling URL if available.";
      this.event("unknown", job, "POST outcome is unknown. No automatic retry; check gateway telemetry before any deliberate resubmission.");
      return job;
    } finally {
      job.controller = null;
      this.#onChange();
    }
  }

  retainPollingUrl(value) {
    this.#requireConnection();
    const validated = validatePollingUrl(value, this.config);
    const existing = this.jobs.find((job) => job.pollUrl === validated.url);
    if (existing) {
      this.resume(existing.id);
      return existing;
    }
    const job = {
      id: `job-${String(this.jobs.length + 1).padStart(3, "0")}`,
      analyzerId: "retained URL", target: "retained", endpoint: null,
      createdAt: this.#now(), acceptedAt: null, resumedOrigin: true,
      status: "Retained · not observed", monitoring: false, pollCount: 0, sessionPolls: 0,
      lastRtt: null, gatewayElapsed: null, pollUrl: validated.url, pinnedRegion: null,
      acceptedRegion: "not known · retained URL", reportedRegion: "not reported", gateway: "not reported", operationId: validated.operationId,
      nextPollAt: 0, result: null, error: null, endedAt: null, terminal: false,
      generation: 0, timer: null, controller: null,
    };
    this.jobs.unshift(job);
    this.event("retained", job, "Retained signed operation attached to APIM. Accepting CU and original submission time are not yet observed. No POST sent.");
    this.resume(job.id);
    return job;
  }

  resume(id) {
    this.#requireConnection();
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job || job.terminal || job.monitoring || !job.pollUrl) return;
    validatePollingUrl(job.pollUrl, this.config);
    job.monitoring = true;
    job.error = null;
    job.sessionStartedAt = this.#now();
    job.sessionPolls = 0;
    job.generation++;
    this.event("monitoring", job, "Regional GET monitoring started. POST is not replayed.");
    this.#schedule(job);
  }

  stop(id, reason = "Monitoring paused. CU work continues; this is not cancellation.") {
    const job = this.jobs.find((candidate) => candidate.id === id);
    if (!job?.monitoring) return;
    job.monitoring = false;
    job.generation++;
    if (job.timer !== null) this.#clearTimer(job.timer);
    job.controller?.abort();
    job.timer = null;
    job.controller = null;
    job.error = reason;
    this.event("paused", job, reason);
  }

  #schedule(job) {
    if (!job.monitoring) return;
    const delay = Math.max(0, job.nextPollAt - this.#now());
    if (job.sessionPolls >= LIMITS.maxPolls || this.#now() + delay - job.sessionStartedAt >= LIMITS.monitoringMs) {
      this.stop(job.id, "Monitoring budget reached (120 polls / 30 minutes per session). Resume deliberately; any Retry-After still applies. CU work is not cancelled.");
      return;
    }
    job.timer = this.#setTimer(() => { void this.#poll(job); }, delay);
    this.#onChange();
  }

  async #poll(job) {
    if (!job.monitoring) return;
    const generation = job.generation;
    job.timer = null;
    const controller = new AbortController();
    job.controller = controller;
    try {
      // Validate again immediately before constructing any credential-bearing request.
      validatePollingUrl(job.pollUrl, this.config);
      if (!this.#key) throw new Error("Missing key.");
      job.pollCount++;
      job.sessionPolls++;
      job.nextPollAt = this.#now() + LIMITS.pollIntervalMs;
      this.#onChange();
      const requestKey = this.#key;
      const { response, payload, text, rtt } = await this.#request(
        job.pollUrl,
        { method: "GET", headers: { "Ocp-Apim-Subscription-Key": requestKey } },
        controller,
        { kind: "Poll result", jobId: job.id, regionId: job.pinnedRegion?.id ?? null },
      );
      if (!job.monitoring || generation !== job.generation) return;
      job.lastRtt = rtt;
      const elapsed = response.headers.get("X-CU-Elapsed-Seconds");
      if (elapsed?.trim() && Number.isFinite(Number(elapsed)) && Number(elapsed) >= 0) job.gatewayElapsed = Number(elapsed);
      job.gateway = safeIdentity(redactText(response.headers.get("X-CU-Gateway") || "", [requestKey]));
      const reportedRegion = safeIdentity(redactText(response.headers.get("X-CU-Region") || "", [requestKey]));
      const identity = this.config.regions.find((region) => region.region === reportedRegion
        && (!response.headers.get("X-CU-Backend") || region.backendId === response.headers.get("X-CU-Backend")));
      if (identity && job.pinnedRegion && identity.id !== job.pinnedRegion.id) {
        this.stop(job.id, "Gateway reported a different CU backend for a pinned operation. Monitoring paused; no POST was replayed.");
        return;
      }
      if (identity) job.pinnedRegion = identity;
      if (reportedRegion !== "not reported") job.reportedRegion = reportedRegion;
      job.nextPollAt = this.#now() + retryAfterMs(response.headers.get("Retry-After"), this.#now());
      job.result = payload ?? text;
      if (!response.ok) {
        job.error = `Polling HTTP ${response.status}. The job remains pinned; no POST replay.`;
        this.event("poll-error", job, `Pinned GET returned HTTP ${response.status}; backend ${job.pinnedRegion?.label || "not yet reported"}.`);
        if (![408, 429, 500, 502, 503, 504].includes(response.status)) {
          this.stop(job.id, `${job.error} Correct the URL/credentials or inspect details before resuming.`);
          return;
        }
      } else {
        const normalized = typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
        const statuses = {
          running: "Running", notstarted: "NotStarted", succeeded: "Succeeded",
          failed: "Failed", canceled: "Canceled", cancelled: "Canceled",
        };
        if (!Object.hasOwn(statuses, normalized)) {
          this.stop(job.id, "Polling response has no supported CU operation status. Inspect details before resuming.");
          return;
        }
        const previous = job.status;
        job.status = statuses[normalized];
        job.error = null;
        if (previous !== job.status) {
          this.event("status", job, `${job.status} observed at ${job.pinnedRegion?.label || "backend not yet reported"}.`);
        }
        if (["Succeeded", "Failed", "Canceled"].includes(job.status)) {
          job.terminal = true;
          job.monitoring = false;
          job.endedAt = this.#now();
          if (job.status !== "Succeeded") job.error = "CU reported a terminal failure/cancellation. Inspect the result JSON. No resubmission was made.";
          this.event("completed", job, `${job.status} observed. Completion time is when this client saw the status, not an internal CU stopwatch.`);
          return;
        }
      }
    } catch {
      if (!job.monitoring || generation !== job.generation) return;
      this.stop(job.id, "Regional polling unreachable (network, CORS, TLS, timeout, or rejected redirect). Fix connectivity and resume this same URL; do not resubmit.");
      return;
    } finally {
      if (job.controller === controller) job.controller = null;
      this.#onChange();
    }
    this.#schedule(job);
  }

  getDisplayUrl(job) { return job.pollUrl ? redactUrl(job.pollUrl) : "No validated polling URL"; }

  getInspectionToken(jobId) {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!this.#key || !job?.pollUrl) return null;
    const tokens = new URL(job.pollUrl).searchParams.getAll("gateway-token");
    if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 4096) return null;
    return redactText(tokens[0], [this.#key]);
  }
}
