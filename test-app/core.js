export const SAMPLE_DOCUMENT_URL = "https://github.com/Azure-Samples/azure-ai-content-understanding-python/raw/refs/heads/main/data/invoice.pdf";

export const DEFAULT_CONFIG = Object.freeze({
  gatewayUrl: "",
  apiVersion: "2025-11-01",
  analyzerIds: ["invoice", "receipt"],
  regions: [
    { id: "a", label: "Primary", region: "swedencentral", backendId: "primary-cu" },
    { id: "b", label: "Secondary", region: "westeurope", backendId: "secondary-cu" },
  ],
});

export const LIMITS = Object.freeze({
  pollIntervalMs: 3_000,
  maxPolls: 120,
  monitoringMs: 30 * 60_000,
  requestTimeoutMs: 30_000,
  maxEvents: 250,
  maxRequests: 250,
  maxTraceBodyChars: 64_000,
});

const sensitiveName = /token|signature|secret|credential|authorization|password|key|(?:^|[-_])sig(?:$|[-_])/i;

function httpsUrl(value, label, { query = false } = {}) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.hash ||
    (!query && url.search) || /[\\\u0000-\u0020]/.test(value.trim())
  ) {
    throw new Error(`${label} must use HTTPS, without credentials, fragments, or unexpected query values.`);
  }
  return url;
}

export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Configuration must be a JSON object.");
  const serialized = JSON.stringify(input);
  if (serialized.length > 20_000) throw new Error("Configuration is too large.");
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [name, child] of Object.entries(value)) {
      if (sensitiveName.test(name) || /subscription.?key/i.test(name)) {
        throw new Error("Configuration must not contain credentials or tokens. Enter the key separately.");
      }
      inspect(child);
    }
  };
  inspect(input);
  const base = (value, label) => {
    const url = httpsUrl(value, label);
    if (/%2f|%5c/i.test(url.pathname)) throw new Error(`${label} contains an ambiguous API path.`);
    return url.href.replace(/\/+$/, "");
  };
  if ("globalUrl" in input || (Array.isArray(input.regions) && input.regions.some((region) => region?.url))) {
    throw new Error("Obsolete two-gateway configuration. Configure one gatewayUrl and two CU backend identities instead.");
  }
  const gatewayUrl = base(input.gatewayUrl, "APIM API base");
  const apiVersion = input.apiVersion ?? DEFAULT_CONFIG.apiVersion;
  if (typeof apiVersion !== "string" || !/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(apiVersion)) {
    throw new Error("Use a date-based API version, for example 2025-11-01.");
  }
  const analyzerIds = input.analyzerIds ?? DEFAULT_CONFIG.analyzerIds;
  if (
    !Array.isArray(analyzerIds) || !analyzerIds.length || analyzerIds.length > 100 ||
    analyzerIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) ||
    new Set(analyzerIds).size !== analyzerIds.length
  ) throw new Error("Provide unique analyzer IDs using letters, numbers, dots, underscores, or hyphens.");
  if (!Array.isArray(input.regions) || input.regions.length !== 2) {
    throw new Error("Configure exactly two CU backend identities.");
  }
  const regions = input.regions.map((region, index) => {
    if (!region || typeof region !== "object") throw new Error("Each region must be a configuration object.");
    const id = region.id ?? (index === 0 ? "a" : "b");
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw new Error("Invalid regional configuration ID.");
    const label = region.label?.trim() || `Region ${index === 0 ? "A" : "B"}`;
    if (typeof label !== "string" || label.length > 80) throw new Error("Region labels must be 80 characters or fewer.");
    if (typeof region.region !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(region.region) ||
        !["primary-cu", "secondary-cu"].includes(region.backendId)) {
      throw new Error("Each backend needs its Azure region and a configured primary-cu/secondary-cu identity.");
    }
    return { id, label, region: region.region, backendId: region.backendId };
  });
  if (new Set(regions.map((region) => region.id)).size !== 2 ||
      new Set(regions.map((region) => region.region)).size !== 2 ||
      new Set(regions.map((region) => region.backendId)).size !== 2) {
    throw new Error("CU backends must have distinct IDs, regions and backend identities.");
  }
  return { gatewayUrl, apiVersion, analyzerIds: [...analyzerIds], regions };
}

export function submissionUrl(base, analyzerId, apiVersion, binary = false) {
  return `${base}/analyzers/${encodeURIComponent(analyzerId)}:${binary ? "analyzeBinary" : "analyze"}?api-version=${encodeURIComponent(apiVersion)}`;
}

export function validatePollingUrl(value, config) {
  const raw = typeof value === "string" ? value.trim() : "";
  const url = httpsUrl(raw, "Operation-Location", { query: true });
  const matches = (() => {
    const base = new URL(config.gatewayUrl);
    const prefix = `${base.pathname.replace(/\/+$/, "")}/analyzerResults/`;
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return false;
    const operationId = url.pathname.slice(prefix.length);
    if (!operationId || operationId.includes("/") || /%2f|%5c/i.test(operationId)) return false;
    try {
      return /^[A-Za-z0-9._~-]+$/.test(decodeURIComponent(operationId)) && ![".", ".."].includes(operationId);
    } catch {
      return false;
    }
  })();
  if (!matches) throw new Error("Polling blocked: Operation-Location is not the configured APIM origin and analyzerResults path.");
  if (url.searchParams.getAll("api-version").length !== 1 || url.searchParams.get("api-version") !== config.apiVersion) {
    throw new Error("Polling blocked: Operation-Location must retain its API version.");
  }
  if ([...url.searchParams.keys()].some((name) => /subscription.?key|authorization/i.test(name))) {
    throw new Error("Polling blocked: credentials must never be placed in a polling URL.");
  }
  return {
    url: raw,
    operationId: decodeURIComponent(url.pathname.split("/").at(-1)),
  };
}

export function decodeRoutingToken(token) {
  const invalid = (error) => ({ claims: null, error });
  if (!token) return invalid("No gateway-token is available for this operation.");
  if (typeof token !== "string" || token.length > 4096) {
    return invalid("The gateway-token exceeds the supported inspection size.");
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] ||
      parts.some((part) => !/^[A-Za-z0-9+/]+={0,2}$/.test(part))) {
    return invalid("This token is opaque or is not a supported Base64 payload and signature.");
  }
  let payload;
  try {
    const bytes = Uint8Array.from(atob(parts[0]), (character) => character.charCodeAt(0));
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error.name === "InvalidCharacterError") {
      return invalid("The token payload is not valid Base64-encoded UTF-8 JSON.");
    }
    throw error;
  }
  const fields = {
    operation: /^[A-Za-z0-9._~-]{1,128}$/,
    region: /^[A-Za-z0-9-]{1,80}$/,
    gateway: /^[A-Za-z0-9._-]{1,128}$/,
    subscription: /^[A-Za-z0-9._-]{1,128}$/,
    apiVersion: /^\d{4}-\d{2}-\d{2}(?:-preview)?$/,
    analyzer: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.entries(fields).some(([name, pattern]) => typeof payload[name] !== "string" || !pattern.test(payload[name])) ||
      !Number.isSafeInteger(payload.started) || payload.started < 0 || payload.started > 8_640_000_000_000_000) {
    return invalid("The decoded payload does not have the expected routing fields.");
  }
  return {
    claims: Object.fromEntries([...Object.keys(fields), "started"].map((name) => [name, payload[name]])),
    error: null,
  };
}

export function configuredBackendUrl(value, config, cuEndpoint) {
  const request = httpsUrl(value, "Browser request URL", { query: true });
  const gateway = new URL(config.gatewayUrl);
  const prefix = gateway.pathname.replace(/\/+$/, "");
  if (request.origin !== gateway.origin || !request.pathname.startsWith(prefix + "/")) {
    throw new Error("The request does not belong to this APIM API.");
  }
  const endpoint = httpsUrl(cuEndpoint, "Configured CU endpoint");
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") + "/contentunderstanding" + request.pathname.slice(prefix.length);
  endpoint.search = request.search;
  endpoint.searchParams.delete("gateway-token");
  return redactUrl(endpoint.href);
}

export function retryAfterMs(value, now = Date.now(), minimum = LIMITS.pollIntervalMs) {
  if (value === null || value === undefined || value === "") return minimum;
  const text = String(value).trim();
  const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1_000 : Date.parse(text) - now;
  return Number.isFinite(delay) ? Math.max(minimum, delay) : minimum;
}

export function safeIdentity(value) {
  return typeof value === "string" && /^[A-Za-z0-9._ /-]{1,80}$/.test(value) ? value : "not reported";
}

export function redactUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const name of [...url.searchParams.keys()]) {
      if (sensitiveName.test(name) || /subscription.?key/i.test(name)) url.searchParams.set(name, "[redacted]");
    }
    return url.href;
  } catch {
    return "[invalid URL]";
  }
}

export function redactText(value, secrets = []) {
  let result = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[redacted]");
  }
  return result.replace(/(gateway-token(?:=|%3D))[^&\s"<>]+/gi, "$1[redacted]");
}

export function redactValue(value, secrets = []) {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      redactText(name, secrets), redactValue(item, secrets),
    ]));
  }
  return value;
}

export function traceValue(value, secrets = []) {
  if (typeof value === "string") {
    return redactText(/^https?:\/\//i.test(value) ? redactUrl(value) : value, secrets);
  }
  if (Array.isArray(value)) return value.map((item) => traceValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      redactText(name, secrets), sensitiveName.test(name) ? "[redacted]" : traceValue(item, secrets),
    ]));
  }
  return value;
}

export function traceBody(value, secrets = []) {
  const safe = traceValue(value, secrets);
  const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  return text.length > LIMITS.maxTraceBodyChars
    ? `${text.slice(0, LIMITS.maxTraceBodyChars)}\n[Trace preview truncated; full result is available in operation details.]` : text;
}

export function duration(ms) {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
