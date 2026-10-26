import {
  DEFAULT_CONFIG, SAMPLE_DOCUMENT_URL, configuredBackendUrl, decodeRoutingToken,
  duration,
} from "./core.js?v=8";
import { Observatory } from "./client.js?v=8";
import { LocalControls } from "./controls.js?v=8";

const $ = (id) => document.getElementById(id);
const create = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
let selectedJob = null;
let renderPending = false;
let lastConfig = null;
let lastEvent = null;
const rows = new Map();
const client = new Observatory({ onChange: scheduleRender });
const controls = new LocalControls(client);
let selectedRequest = null;
const traceRows = new Map();
const controlNodes = new Map();
let controlRefreshPending = false;
let submitting = false;
let inspectedResponse = null;
let suppressTokenFocus = false;
let rewriteSnapshot = null;

function selectDetailTab(id, focus = false) {
  hideToken();
  for (const tab of document.querySelectorAll('.detail-tabs [role="tab"]')) {
    const selected = tab.id === id;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !selected;
    if (selected && focus) tab.focus();
  }
}

const tabs = [...document.querySelectorAll('.detail-tabs [role="tab"]')];
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener("click", () => selectDetailTab(tab.id));
  tab.addEventListener("keydown", (event) => {
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
    if (next === null) return;
    event.preventDefault();
    selectDetailTab(tabs[next].id, true);
  });
}

const divider = $("pane-divider");
let traceShare = 55;
let dragOffset = 0;
function resizePanes(share) {
  traceShare = Math.min(80, Math.max(20, share));
  $("lab-layout").style.setProperty("--trace-fraction", `${traceShare / (100 - traceShare)}fr`);
  divider.setAttribute("aria-valuenow", String(Math.round(traceShare)));
  divider.setAttribute("aria-valuetext", `Network trace ${Math.round(traceShare)} percent, request details ${100 - Math.round(traceShare)} percent`);
}
divider.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragOffset = event.clientX - divider.getBoundingClientRect().left;
  divider.setPointerCapture(event.pointerId);
  divider.focus();
  $("lab-layout").classList.add("resizing");
});
divider.addEventListener("pointermove", (event) => {
  if (!divider.hasPointerCapture(event.pointerId)) return;
  const bounds = $("lab-layout").getBoundingClientRect();
  resizePanes((event.clientX - bounds.left - dragOffset) / (bounds.width - divider.offsetWidth) * 100);
});
for (const name of ["pointerup", "pointercancel"]) {
  divider.addEventListener(name, (event) => {
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  });
}
divider.addEventListener("lostpointercapture", () => $("lab-layout").classList.remove("resizing"));
divider.addEventListener("keydown", (event) => {
  const share = event.key === "Home" ? 20 : event.key === "End" ? 80
    : event.key === "ArrowLeft" ? traceShare - 5 : event.key === "ArrowRight" ? traceShare + 5 : null;
  if (share === null) return;
  event.preventDefault();
  resizePanes(share);
});
divider.addEventListener("dblclick", () => resizePanes(55));
resizePanes(traceShare);

function notify(message, error = false) {
  const node = $("feedback");
  node.textContent = client.safe(message);
  node.className = error ? "feedback error" : "feedback";
  node.hidden = false;
}

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  queueMicrotask(() => { renderPending = false; render(); });
}

function readConfig() {
  return {
    gatewayUrl: $("gateway-url").value,
    apiVersion: $("api-version").value,
    analyzerIds: $("analyzer-ids").value.split(",").map((id) => id.trim()).filter(Boolean),
    regions: ["a", "b"].map((id) => ({
      id, label: $(`region-${id}-label`).value,
      region: $(`region-${id}-region`).value,
      backendId: id === "a" ? "primary-cu" : "secondary-cu",
    })),
  };
}

function fillConfig(config) {
  $("gateway-url").value = config.gatewayUrl ?? "";
  $("api-version").value = config.apiVersion ?? DEFAULT_CONFIG.apiVersion;
  $("analyzer-ids").value = (config.analyzerIds ?? DEFAULT_CONFIG.analyzerIds).join(", ");
  config.regions.forEach((region, index) => {
    const id = index === 0 ? "a" : "b";
    $(`region-${id}-label`).value = region.label;
    $(`region-${id}-region`).value = region.region;
  });
}

function updateRouteHelp() {
  $("route-help").textContent = "One APIM HTTPS endpoint for every POST and GET. APIM selects new work; each signed result URL retains its accepting CU backend.";
}

$("config-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    client.configure(readConfig());
    notify("Single APIM connection applied. Add your serving key to submit.");
  } catch (error) { notify(error.message, true); }
});

$("config-import").addEventListener("change", async (event) => {
  const input = event.target;
  try {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 20_000) throw new Error("Configuration file must be 20 KB or smaller.");
    const config = JSON.parse(await file.text());
    client.configure(config);
    fillConfig(client.config);
    notify("Imported safe runtime configuration. Enter the subscription key separately.");
  } catch { notify("Import failed: use valid endpoint/analyzer configuration JSON without secrets, and no existing jobs.", true); }
  finally { input.value = ""; }
});

$("key-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    hideToken();
    client.setKey($("subscription-key").value);
    $("subscription-key").value = "";
    $("key-setup").open = false;
    $("key-setup").querySelector("summary").focus();
    notify("Serving key is in memory for this tab only. The input field has been cleared.");
  } catch (error) { notify(error.message, true); }
});
$("clear-key").addEventListener("click", () => {
  hideToken();
  client.clearKey();
  $("subscription-key").value = "";
  $("key-setup").open = true;
  $("subscription-key").focus();
  notify("Serving key cleared and monitoring paused. CU operations are not cancelled.");
});
$("target").addEventListener("change", () => { updateRouteHelp(); render(); });
for (const radio of document.querySelectorAll('input[name="input-mode"]')) {
  radio.addEventListener("change", () => {
    const isFile = radio.value === "file";
    $("document-url-label").hidden = isFile;
    $("document-file-label").hidden = !isFile;
  });
}
$("submit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submitting) return;
  const binary = document.querySelector('input[name="input-mode"]:checked').value === "file";
  try {
    if (binary && !$("document-file").files[0]) throw new Error("Choose a document file first.");
    submitting = true;
    $("submit-button").disabled = true;
    const target = $("target").value;
    const input = {
      target, analyzerId: $("analyzer").value,
      documentUrl: binary ? undefined : $("document-url").value.trim(),
      file: binary ? $("document-file").files[0] : undefined,
    };
    const job = await client.submit(input);
    $("document-file").value = "";
    selectedRequest = client.requests.findLast((entry) => entry.jobId === job.id)?.id || selectedRequest;
    notify(job.error || `${job.id} accepted. Monitoring follows only its validated regional URL.`, Boolean(job.error));
  } catch (error) { notify(error.message, true); }
  finally { submitting = false; scheduleRender(); }
});
$("resume-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const job = client.retainPollingUrl($("retained-url").value);
    $("retained-url").value = "";
    notify(`${job.id}: retained regional operation attached. No POST submitted.`);
  } catch (error) { notify(error.message, true); }
});
$("pause-all").addEventListener("click", () => {
  client.jobs.forEach((job) => client.stop(job.id));
  notify("All result monitoring paused. This does not cancel CU work or observe further pending-job latency.");
});
function tone(job) {
  if (job.status === "Succeeded") return "success";
  if (job.status === "Failed" || job.status === "Canceled" || job.status.includes("Rejected")) return "danger";
  if (job.error) return "warning";
  return "neutral";
}

function renderConfig() {
  const config = client.config;
  if (config !== lastConfig) {
    lastConfig = config;
    $("analyzer").replaceChildren(...config.analyzerIds.map((id) => {
      const option = create("option", id);
      option.value = id;
      return option;
    }));
    updateRouteHelp();
    $("connection-state").textContent = "Single APIM configured";
    $("connection-state").className = "badge success";
    for (const region of config.regions) {
      $(`region-${region.id}-title`).textContent = region.label;
    }
  }
  const locked = client.jobs.length > 0;
  for (const input of $("config-form").elements) input.disabled = locked;
}

function newRow(job) {
  const tr = create("tr");
  tr.dataset.job = job.id;
  const cells = Array.from({ length: 8 }, () => create("td"));
  const title = create("strong", job.id);
  cells[0].append(title, create("small", job.analyzerId));
  const status = create("span", job.status, "badge neutral job-status");
  cells[1].append(status);
  const region = create("strong");
  const host = create("small");
  cells[2].append(region, host);
  cells[7].className = "job-controls";
  const detail = create("button", "Details");
  detail.type = "button";
  detail.setAttribute("aria-label", `Details for ${job.id}`);
  detail.addEventListener("click", () => {
    selectedJob = job.id;
    renderDetails();
    $("job-dialog").showModal();
  });
  const toggle = create("button", "Pause");
  toggle.type = "button";
  toggle.addEventListener("click", () => {
    try {
      if (job.monitoring) client.stop(job.id);
      else client.resume(job.id);
    } catch (error) { notify(error.message, true); }
  });
  cells[7].append(detail, toggle);
  tr.append(...cells);
  $("jobs-body").prepend(tr);
  const row = { tr, cells, status, region, host, toggle };
  rows.set(job.id, row);
  return row;
}

function renderJobs(now) {
  if (client.jobs.length && !rows.size) $("jobs-body").replaceChildren();
  for (const job of [...client.jobs].reverse()) {
    const row = rows.get(job.id) || newRow(job);
    row.status.textContent = job.status;
    row.status.className = `badge ${tone(job)} job-status`;
    row.region.textContent = job.pinnedRegion?.label || job.reportedRegion;
    row.host.textContent = job.pollUrl ? new URL(job.pollUrl).host : "No safe polling URL";
    row.cells[3].textContent = job.gatewayElapsed !== null
      ? `${job.gatewayElapsed}s${job.status === "Succeeded" ? " · POST → success" : " · POST → last GET"}`
      : job.resumedOrigin ? `${duration((job.endedAt || now) - job.createdAt)} since attach` : duration((job.endedAt || now) - job.createdAt);
    row.cells[4].textContent = job.pollCount;
    row.cells[5].textContent = job.lastRtt === null ? "—" : `${Math.round(job.lastRtt)}ms`;
    row.cells[6].textContent = job.terminal ? "Finished" : job.monitoring ? `Next ≥ ${duration(job.nextPollAt - now)}` : "Paused / not started";
    row.toggle.textContent = job.monitoring ? "Pause" : "Resume";
    row.toggle.disabled = job.terminal || !job.pollUrl || !client.hasKey;
    row.toggle.setAttribute("aria-label", `${job.monitoring ? "Pause" : "Resume"} monitoring for ${job.id}`);
  }
  $("job-count").textContent = client.jobs.length;
  $("pause-all").disabled = !client.jobs.some((job) => job.monitoring);
}

function renderTimeline() {
  if (!client.events.length) return;
  if (client.events[0] === lastEvent) return;
  lastEvent = client.events[0];
  if (lastEvent?.jobId) $("job-announcement").textContent = client.safe(`${lastEvent.jobId}: ${lastEvent.message}`);
  $("timeline").replaceChildren(...client.events.map((event) => {
    const li = create("li", undefined, `event-${event.type}`);
    const time = create("time", new Date(event.time).toLocaleTimeString());
    time.dateTime = new Date(event.time).toISOString();
    li.append(time);
    if (event.jobId) li.append(create("span", event.jobId, "event-job"));
    li.append(create("p", client.safe(event.message)));
    return li;
  }));
}

function renderDetails() {
  const job = client.jobs.find((candidate) => candidate.id === selectedJob);
  if (!job) return;
  $("detail-title").textContent = `${job.id} · ${job.status}`;
  const entries = [
    ["Analyzer", job.analyzerId], ["Operation correlation", job.operationId || "Not available"],
    ["Original submission API base", job.endpoint || "Retained URL; original submission unknown"],
    ["Submission route", job.target === "retained" ? "Retained signed operation" : "Single APIM; active backend selects new work"],
    ["Accepted region header", job.acceptedRegion], ["Latest response region header", job.reportedRegion],
    ["Gateway header", job.gateway],
    ["Pinned CU backend", job.pinnedRegion?.label || "Not yet reported"],
    ["Poll count", String(job.pollCount)],
    ["Last HTTP round-trip", job.lastRtt === null ? "Not available" : `${Math.round(job.lastRtt)}ms`],
    ["Gateway POST → result GET", job.gatewayElapsed === null ? "Not reported"
      : `${job.gatewayElapsed}s from POST arrival to ${job.status === "Succeeded" ? "successful result" : "last result"} response; includes polling delay, not pure CU engine time`],
    ["Original job age", job.resumedOrigin ? "Unknown; retained URL only" : duration((job.endedAt || Date.now()) - job.createdAt)],
    ["Monitoring / error", job.error || (job.monitoring ? "Monitoring regional URL" : "Complete or not monitoring")],
  ];
  $("detail-fields").replaceChildren(...entries.map(([name, value]) => {
    const group = create("div");
    group.append(create("dt", name), create("dd", client.safe(value)));
    return group;
  }));
  $("detail-url").value = client.getDisplayUrl(job);
  $("copy-url").disabled = !job.pollUrl;
  $("detail-result").textContent = client.safe(job.result === null ? "No result payload received yet." : typeof job.result === "string" ? job.result : JSON.stringify(job.result, null, 2));
}

$("close-dialog").addEventListener("click", () => $("job-dialog").close());
$("job-dialog").addEventListener("close", () => { selectedJob = null; });
$("copy-url").addEventListener("click", async () => {
  const job = client.jobs.find((candidate) => candidate.id === selectedJob);
  if (!job?.pollUrl) return;
  try {
    await navigator.clipboard.writeText(job.pollUrl);
    notify("Complete polling URL copied, including its signed token. Keep it private and clear your clipboard when done.");
  } catch { notify("Clipboard unavailable. Use the browser network panel to retain the full Operation-Location privately.", true); }
});

function fields(node, entries) {
  node.replaceChildren(...entries.map(([name, value]) => {
    const group = create("div");
    group.append(create("dt", name), create("dd", client.safe(value)));
    return group;
  }));
}

$("clear-trace").addEventListener("click", () => { hideToken(); selectedRequest = null; client.clearRequests(); });
$("trace-filter").addEventListener("change", scheduleRender);

function hideToken(focus = false) {
  $("token-popover").hidden = true;
  $("full-token").textContent = "";
  $("decoded-token-fields").replaceChildren();
  $("token-decode-error").textContent = "";
  $("inspect-token").setAttribute("aria-expanded", "false");
  if (focus) {
    suppressTokenFocus = true;
    $("inspect-token").focus();
    suppressTokenFocus = false;
  }
}

function selectedPollingToken() {
  const entry = client.requests.find((candidate) => candidate.id === selectedRequest);
  const job = client.jobs.find((candidate) => candidate.id === entry?.jobId);
  if (!client.hasKey || !job?.pollUrl || !["Analyze", "Poll result"].includes(entry.kind)) return null;
  return client.getInspectionToken(job.id);
}

function openToken() {
  const token = selectedPollingToken();
  if (!token || $("inspector-panel").hidden) return;
  const decoded = decodeRoutingToken(token);
  $("full-token").textContent = token;
  $("token-decode-error").textContent = decoded.error || "";
  fields($("decoded-token-fields"), decoded.claims ? [
    ["Operation ID claim", decoded.claims.operation], ["Accepting region claim", decoded.claims.region],
    ["Gateway claim", decoded.claims.gateway], ["APIM subscription ID claim", decoded.claims.subscription],
    ["API version claim", decoded.claims.apiVersion], ["Analyzer claim", decoded.claims.analyzer],
    ["Submission timestamp claim (UTC)", new Date(decoded.claims.started).toISOString()],
    ["Signature", "Not verified by this browser. APIM validates the HMAC before routing."],
  ] : []);
  $("token-popover").hidden = false;
  $("inspect-token").setAttribute("aria-expanded", "true");
}

$("inspect-token").addEventListener("pointerenter", openToken);
$("inspect-token").addEventListener("focus", () => { if (!suppressTokenFocus) openToken(); });
$("inspect-token").addEventListener("click", openToken);
$("close-token").addEventListener("click", () => hideToken(true));
$("token-view").addEventListener("pointerleave", () => {
  if (!$("token-view").contains(document.activeElement)) hideToken();
});
$("token-view").addEventListener("focusout", () => queueMicrotask(() => {
  if (!$("token-view").contains(document.activeElement) && !$("token-view").matches(":hover")) hideToken();
}));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("token-popover").hidden) {
    event.preventDefault();
    hideToken($("token-view").contains(document.activeElement));
  }
});

function responseHeader(entry, name) {
  return Object.entries(entry.responseHeaders).find(([key]) => key.toLowerCase() === name)?.[1] || "";
}

function backendLabel(region) {
  if (!region) return "Not reported";
  const role = region.backendId === "primary-cu" ? "Primary" : "Secondary";
  return `${role}${region.label === role ? "" : ` (${region.label})`} · ${region.region} · ${region.backendId}`;
}

function responseRegion(entry) {
  return client.config?.regions.find((region) => region.region === entry.reportedRegion &&
    (!entry.reportedBackend || entry.reportedBackend === "not reported" || region.backendId === entry.reportedBackend));
}

function deploymentRegion(region) {
  return region && controls.matches(client.config)
    ? controls.state.deployment.regions.find((candidate) => candidate.id === region.id) : null;
}

function renderLearning(entry) {
  const context = `${entry?.id || ""}:${client.hasKey}`;
  if (context !== inspectedResponse) {
    hideToken();
    inspectedResponse = context;
  }
  if (!entry) { $("token-view").hidden = true; return; }
  const job = client.jobs.find((candidate) => candidate.id === entry.jobId);
  const location = responseHeader(entry, "operation-location");
  const responseId = entry.responseId && entry.responseId !== "not reported" ? entry.responseId : null;
  const operationId = responseId || job?.operationId;
  $("highlight-operation-id").textContent = client.safe(operationId || "Not reported");
  const status = entry.cuStatus && entry.cuStatus !== "not reported" ? entry.cuStatus : "Not reported";
  $("highlight-cu-status").textContent = client.safe(status);
  $("highlight-cu-status").className = `badge ${status.toLowerCase() === "succeeded" ? "success"
    : ["failed", "canceled"].includes(status.toLowerCase()) ? "danger"
      : ["running", "notstarted"].includes(status.toLowerCase()) ? "warning" : "neutral"}`;
  $("operation-location-text").textContent = location || "No Operation-Location header returned.";
  const isPoll = entry.kind === "Poll result";
  $("polled-url").hidden = !isPoll;
  $("polled-url-text").textContent = isPoll ? entry.url : "";
  const token = selectedPollingToken();
  const showToken = Boolean(token && (isPoll || location));
  const accepting = job?.pinnedRegion || responseRegion(entry);
  const resourceId = deploymentRegion(accepting)?.foundryResourceId;
  const resourceName = typeof resourceId === "string" ? /\/([A-Za-z0-9-]{1,64})\/?$/.exec(resourceId)?.[1] : null;
  const resourceLabel = resourceName || (accepting ? `${accepting.backendId} · ${accepting.region}` : "accepting backend unknown");
  const triggerText = client.safe(`[${resourceLabel}] hover for details`);
  if ($("inspect-token").textContent !== triggerText) $("inspect-token").textContent = triggerText;
  const target = isPoll ? $("polled-url-value") : $("highlight-location");
  if (showToken && $("token-view").parentElement !== target) target.append($("token-view"));
  $("token-view").hidden = !showToken;
  $("operation-location-text").hidden = showToken && !isPoll;
  $("polled-url-text").hidden = showToken;
  $("token-help").hidden = !job?.pollUrl;
  if (showToken) {
    const display = client.safe(client.getDisplayUrl(job));
    const match = /([?&]gateway-token=)[^&]*/i.exec(display);
    $("token-url-prefix").textContent = match ? display.slice(0, match.index) + match[1] : display;
    $("token-url-suffix").textContent = match ? display.slice(match.index + match[0].length) : "";
  }
  const reported = responseRegion(entry);
  const active = client.config?.regions.find((region) => region.backendId === entry.activeBackend);
  fields($("routing-evidence-fields"), [
    ["Gateway-reported backend in this response", reported ? backendLabel(reported)
      : entry.reportedBackend && entry.reportedBackend !== "not reported"
        ? `${entry.reportedBackend} / ${entry.reportedRegion} (unrecognized or inconsistent identity)` : "Not reported"],
    ["Operation's observed accepting backend", backendLabel(job?.pinnedRegion)],
    ["Active new-work backend in this response", active ? backendLabel(active) : "Not reported in this response"],
    ["CU operation ID source", responseId ? "Selected CU response body" : operationId ? "Validated polling URL" : "Not available"],
  ]);
  const decoded = token ? decodeRoutingToken(token) : null;
  const claimed = client.config?.regions.find((region) => region.region === decoded?.claims?.region);
  const disagrees = decoded?.claims && ((reported && reported.region !== decoded.claims.region) ||
    (operationId && operationId !== decoded.claims.operation));
  $("token-claim-note").textContent = client.safe(decoded?.claims
    ? `Decoded token claims ${claimed ? backendLabel(claimed) : decoded.claims.region + " (not a configured region)"}. Not verified by this browser.${disagrees ? " Warning: token claims and response evidence disagree." : ""}`
    : token ? decoded.error : job?.pollUrl ? "Token inspection is unavailable while the serving key is cleared or the token is missing/oversized." : "No validated signed polling URL is available for this request.");
  $("token-claim-note").classList.toggle("error-note", Boolean(disagrees));
  $("routing-evidence-note").textContent = ["Analyze", "Poll result"].includes(entry.kind)
    ? "The browser sees one APIM hostname. Backend identity is gateway-reported, not a browser-captured CU hop. New-work selection cannot move an existing operation."
    : "This is a local Azure-control request, not a CU analysis hop.";
}

function renderRewriteGuide() {
  const entry = client.requests.find((candidate) => candidate.id === selectedRequest);
  const job = client.jobs.find((candidate) => candidate.id === entry?.jobId);
  const region = entry && (responseRegion(entry) || (entry.kind === "Poll result" ? job?.pinnedRegion : null));
  const deployed = deploymentRegion(region);
  const snapshot = JSON.stringify([entry?.id, entry?.completedAt, entry?.reportedRegion, entry?.reportedBackend,
    client.config, region, deployed?.cuEndpoint, job?.operationId, job?.pollUrl ? client.getDisplayUrl(job) : null]);
  if (snapshot === rewriteSnapshot) return;
  rewriteSnapshot = snapshot;
  if (!entry || !["Analyze", "Poll result"].includes(entry.kind)) {
    $("rewrite-mappings").replaceChildren();
    $("rewrite-context").textContent = entry
      ? `${entry.kind}: no CU analysis URL rewrite. Local controls use Azure management.`
      : "Select an Analyze or result GET in the trace to see its URL mappings.";
    return;
  }
  const mappings = document.createDocumentFragment();
  const backend = (url) => deployed?.cuEndpoint
    ? configuredBackendUrl(url, client.config, deployed.cuEndpoint)
    : region ? `${region.backendId} (${region.region}) · CU endpoint not supplied by the matching helper`
      : "CU backend not reported; destination cannot be reconstructed";
  const mapping = (title, from, to, note) => {
    const node = create("div", undefined, "url-mapping");
    node.append(create("h4", title), create("code", client.safe(from)), create("span", "→", "mapping-arrow"),
      create("code", client.safe(to)), create("p", note, "fine-print"));
    mappings.append(node);
  };
  const inferred = "Backend URL is a configuration-derived illustration, not a browser-captured request or original CU response header.";
  $("rewrite-context").textContent = `${entry.id} · ${entry.kind}: ${region ? backendLabel(region) : "backend not reported"}. Browser-visible URLs stay on APIM.`;
  if (entry.kind === "Analyze") {
    mapping("1. Analyze request · APIM forwards to selected CU", entry.url, backend(entry.url), inferred);
    const location = responseHeader(entry, "operation-location");
    if (location) mapping("2. Accepted response · Operation-Location rewritten",
      job?.pollUrl ? backend(client.getDisplayUrl(job)) : "Original CU result URL not available",
      location, `${inferred} The returned APIM URL includes a signed accepting-region token.`);
  } else {
    mapping("Result GET · APIM forwards to accepting CU", entry.url, backend(entry.url),
      `${inferred} APIM verifies the token, selects the accepting backend and strips gateway-token before forwarding. The client URL is unchanged; this is not another response-header rewrite.`);
  }
  $("rewrite-mappings").replaceChildren(mappings);
}

function renderTrace(now) {
  const retained = new Set(client.requests.map((entry) => entry.id));
  for (const [id, row] of traceRows) {
    if (!retained.has(id)) { row.tr.remove(); traceRows.delete(id); }
  }
  if (!client.requests.length) {
    if (!$("trace-body").querySelector(".empty")) {
      const tr = create("tr");
      const td = create("td", "No requests recorded. Submit an analysis to observe real routing.", "empty");
      td.colSpan = 6;
      tr.append(td);
      $("trace-body").replaceChildren(tr);
    }
  } else {
    $("trace-body").querySelector(".empty")?.closest("tr").remove();
    for (const entry of client.requests) {
      let row = traceRows.get(entry.id);
      if (!row) {
        const tr = create("tr");
        tr.dataset.request = entry.id;
        const cells = Array.from({ length: 6 }, () => create("td"));
        const button = create("button", "", "trace-link");
        button.type = "button";
        button.setAttribute("aria-label", `Inspect request ${entry.id}`);
        button.addEventListener("click", () => {
          hideToken();
          selectedRequest = entry.id;
          $("routes-panel").scrollTop = 0;
          scheduleRender();
        });
        const subtitle = create("small");
        cells[3].append(button, subtitle);
        tr.append(...cells);
        $("trace-body").append(tr);
        row = { tr, cells, button, subtitle };
        traceRows.set(entry.id, row);
      }
      const filter = $("trace-filter").value;
      row.tr.hidden = filter === "analysis" ? !["Analyze", "Poll result"].includes(entry.kind)
        : filter === "control" ? entry.kind !== "Azure control" : false;
      row.tr.classList.toggle("selected", entry.id === selectedRequest);
      row.cells[0].textContent = new Date(entry.startedAt).toLocaleTimeString();
      row.cells[1].textContent = entry.method;
      row.cells[2].textContent = entry.error ? "Error" : entry.status ?? "Pending";
      row.cells[2].className = entry.error || entry.status >= 400 ? "trace-error" : entry.status ? "trace-ok" : "";
      const url = new URL(entry.url);
      row.button.textContent = url.pathname + url.search;
      row.subtitle.textContent = `${entry.kind} · ${url.host}${entry.jobId ? " · " + entry.jobId : ""}`;
      row.cells[4].textContent = client.config?.regions.find((region) => region.id === entry.regionId)?.label || "Not reported";
      row.cells[5].textContent = entry.rtt === null ? duration(now - entry.startedAt) : `${Math.round(entry.rtt)}ms`;
    }
  }
  const visible = [...traceRows.values()].filter((row) => !row.tr.hidden).length;
  if (client.requests.length && !visible) {
    const tr = create("tr");
    const td = create("td", "No requests match this filter. Submit an analysis or choose another request type.", "empty");
    td.colSpan = 6;
    tr.append(td);
    $("trace-body").append(tr);
  }
  $("request-count").textContent = client.requests.length === visible ? String(visible) : `${visible} / ${client.requests.length}`;
  const entry = client.requests.find((candidate) => candidate.id === selectedRequest);
  $("request-content").hidden = !entry;
  $("request-empty").hidden = Boolean(entry);
  $("request-title").textContent = entry ? `${entry.method} · ${entry.status ?? (entry.error ? "error" : "in flight")}` : "Select a request";
  $("request-kind").textContent = entry?.kind || "Nothing selected";
  renderLearning(entry);
  if (!entry) return;
  $("request-url").value = entry.url;
  fields($("request-fields"), [
    ["Request", entry.id], ["Operation", entry.jobId || "Not an analysis operation"],
    ["Started", new Date(entry.startedAt).toLocaleTimeString()],
    ["HTTP round-trip", entry.rtt === null ? "In flight" : `${Math.round(entry.rtt)}ms`],
    ["Configured destination region", client.config?.regions.find((region) => region.id === entry.regionId)?.label || "Not reported"],
    ["Response region header", entry.reportedRegion || "Not reported"],
    ["CU status in this response", entry.cuStatus && entry.cuStatus !== "not reported" ? entry.cuStatus : "Not reported"],
    ["Gateway POST → this result GET", entry.gatewayElapsed === null ? "Not reported" : `${entry.gatewayElapsed}s (includes polling delay; not engine execution time)`],
    ["Runtime threshold in this response", entry.thresholdSeconds === null ? "Not reported" : `${entry.thresholdSeconds}s`],
    ["Degradation signal in this response", entry.degradationReason && entry.degradationReason !== "not reported" ? entry.degradationReason : "Not reported / not triggered"],
  ]);
  $("request-headers").textContent = JSON.stringify(entry.requestHeaders, null, 2);
  $("request-body").textContent = entry.requestBody || "No request body.";
  $("response-headers").textContent = JSON.stringify(entry.responseHeaders, null, 2);
  $("response-body").textContent = entry.error || entry.responseBody || (entry.completedAt === null ? "Waiting for response." : "No response body.");
}

async function refreshControls({ automatic = false } = {}) {
  if (controlRefreshPending) return;
  controlRefreshPending = true;
  try { await controls.refresh(); }
  catch (error) {
    controls.state = { ...(controls.state || {}), error: `Local helper unavailable: ${error.message}` };
    $("control-error").textContent = client.safe(`Local Azure helper unavailable: ${error.message}`);
    if (!automatic) notify("Could not refresh Azure control state. The control helper may be stopped; analysis still goes directly to APIM.", true);
  } finally { controlRefreshPending = false; scheduleRender(); }
}
$("refresh-control").addEventListener("click", () => { void refreshControls(); });

$("test-failover").addEventListener("click", () => {
  const region = client.config && { id: "gateway", label: "Gateway" };
  const nodes = region && controlNodes.get(region.id);
  if (!nodes || nodes.apply.disabled) {
    notify("The 2-second test is unavailable. Refresh Azure state and restore any existing threshold override first.", true);
    return;
  }
  nodes.threshold.value = "2";
  nodes.threshold.dispatchEvent(new Event("input"));
  void changeControl(region, "threshold");
});
$("restore-test-threshold").addEventListener("click", () => {
  const region = client.config && { id: "gateway", label: "Gateway" };
  if (region) void changeControl(region, "threshold", true);
});
$("reset-primary").addEventListener("click", () => {
  const nodes = controlNodes.get("gateway");
  if (!nodes || nodes.restoreEndpoint.disabled) {
    notify("Manual reset is unavailable. Connect the matching helper and refresh Azure state first.", true);
    return;
  }
  void selectBackend("primary-cu");
});

async function changeControl(region, kind, restore = false) {
  if (!controls.matches(client.config)) {
    notify("Azure controls are limited to the helper's exact deployment endpoints.", true);
    return;
  }
  try {
    const body = restore ? { regionId: region.id, kind } : {
      regionId: region.id, kind,
      durationSeconds: Number($(`control-duration-${region.id}`).value),
      ...(kind === "threshold" ? { thresholdSeconds: Number($(`threshold-${region.id}`).value) } : {}),
    };
    const action = controls.change(restore ? "restore" : "apply", body);
    scheduleRender();
    await action;
    notify(restore ? "Threshold restored. Active CU backend is unchanged; reset explicitly if required."
      : "Temporary threshold saved with automatic restoration. Wait for gateway runtime configuration to catch up.");
  } catch (error) { notify(error.message, true); }
  finally { scheduleRender(); }
}

function regionControls(region, now) {
  let nodes = controlNodes.get(region.id);
  if (!nodes) {
    const root = $(`controls-${region.id}`);
    const thresholdLabel = create("label", "POST-to-result threshold (seconds)");
    const threshold = create("input");
    Object.assign(threshold, { id: `threshold-${region.id}`, type: "number", min: "1", max: "300", step: "1", value: "5" });
    thresholdLabel.append(threshold);
    const durationLabel = create("label", "Restore automatically after");
    const select = create("select");
    select.id = `control-duration-${region.id}`;
    for (const seconds of [180, 300, 600]) {
      const option = create("option", `${seconds / 60} minutes`);
      option.value = seconds;
      select.append(option);
    }
    select.value = "300";
    durationLabel.append(select);
    const apply = create("button", "Use 5s temporarily");
    const force = create("button", "Select secondary manually", "force-button");
    const restoreThreshold = create("button", "Restore threshold", "quiet");
    const restoreEndpoint = create("button", "Reset to primary", "quiet");
    for (const button of [apply, force, restoreThreshold, restoreEndpoint]) button.type = "button";
    apply.addEventListener("click", () => { void changeControl(region, "threshold"); });
    force.addEventListener("click", () => { void selectBackend("secondary-cu"); });
    restoreThreshold.addEventListener("click", () => { void changeControl(region, "threshold", true); });
    restoreEndpoint.addEventListener("click", () => { void selectBackend("primary-cu"); });
    threshold.addEventListener("input", () => { apply.textContent = `Use ${threshold.value || "…"}s temporarily`; });
    const status = create("p", "", "control-status");
    const toolbar = create("div", undefined, "toolbar");
    toolbar.append(apply, restoreThreshold, force, restoreEndpoint);
    root.append(create("h3", "Real Azure test controls"), thresholdLabel, durationLabel, toolbar, status,
      create("p", "Threshold: POST-to-result elapsed time on an actual primary GET must exceed it, while pending or on success. Manual selection changes persistent routing, not job affinity. Threshold restoration does not reset routing.", "fine-print"));
    nodes = { threshold, select, apply, force, restoreThreshold, restoreEndpoint, status };
    controlNodes.set(region.id, nodes);
  }
  const state = controls.state;
  const current = state?.leases?.filter((lease) => lease.regionId === region.id) || [];
  const thresholdLease = current.find((lease) => lease.kind === "threshold");
  const fresh = state?.checkedAt && now / 1000 - state.checkedAt <= 45;
  const available = controls.matches(client.config) && fresh && !state.error && !controls.busy;
  nodes.apply.disabled = !available || Boolean(thresholdLease);
  nodes.force.disabled = !available;
  nodes.restoreThreshold.disabled = !thresholdLease || controls.busy;
  nodes.restoreEndpoint.disabled = !available;
  nodes.apply.setAttribute("aria-label", `Apply temporary threshold for ${region.label}`);
  nodes.force.setAttribute("aria-label", "Select secondary manually");
  const gateway = client.gatewayObservation?.thresholdSeconds;
  const configured = state?.thresholdSeconds;
  const lines = [
    available || current.length ? `Azure threshold: ${configured ?? "not refreshed"}s. Last analysis response threshold: ${gateway === null || gateway === undefined ? "not observed" : gateway + "s"}.` : "Controls unavailable until the helper is connected to these exact endpoints and has fresh Azure state.",
    ...current.map((lease) => `${lease.kind}: ${lease.status}; original ${lease.original}; ${lease.expiresAt * 1000 > now ? "restore in " + duration(lease.expiresAt * 1000 - now) : "restoration due, awaiting confirmation"}.${lease.error ? " " + lease.error : ""}`),
  ];
  nodes.status.textContent = lines.join("\n");
  nodes.status.classList.toggle("error-note", current.some((lease) => lease.error));
}

async function selectBackend(backendId) {
  if (!controls.matches(client.config)) {
    notify("Azure controls are limited to the helper's exact deployment endpoints.", true);
    return;
  }
  try {
    const pending = controls.change("select", { backendId });
    scheduleRender();
    await pending;
    notify(`Management selection is ${backendId}. Wait for runtime activation; existing jobs remain pinned. This was manual steering.`);
  } catch (error) { notify(error.message, true); }
  finally { scheduleRender(); }
}

function renderResources(now) {
  const state = controls.state;
  const matched = controls.matches(client.config);
  $("control-connection").textContent = state?.enabled ? "LOCAL AZURE CONTROLS · REAL ENDPOINTS" : "LOCAL CLIENT · DIRECT APIM REQUESTS";
  $("control-summary").textContent = matched
    ? `${state.deployment.resourceGroup} · ${state.deployment.subscription}. Expand a resource to inspect or change its supported test settings.`
    : state?.error || "Use the local Azure helper for real temporary controls. Endpoint configuration and direct APIM analysis remain available.";
  if (state?.enabled) $("control-error").textContent = state.error || "";
  $("refresh-control").disabled = controlRefreshPending || controls.busy;
  $("gateway-host").textContent = client.config ? new URL(client.config.gatewayUrl).host : "One APIM HTTPS origin";
  fields($("gateway-fields"), [
    ["Azure resource", matched ? state.deployment.gateway.resourceId : "Not supplied by helper"],
    ["Management selection", matched ? state.activeBackend || "Not observed" : "Not connected"],
    ["Last analysis response selection", client.gatewayObservation?.activeBackend || "Not observed"],
    ["Last analysis response threshold", client.gatewayObservation?.thresholdSeconds
      ? `${client.gatewayObservation.thresholdSeconds}s` : "Not observed"],
    ["Response observation", client.gatewayObservation ? `${client.gatewayObservation.requestId} · ${duration(now - client.gatewayObservation.checkedAt)} ago (not a live health check)` : "Submit or poll an analysis to observe runtime behavior"],
    ["Timing policy in last response", client.gatewayObservation?.trigger === "operation-duration"
      ? "POST → result duration: pending and successful results"
      : client.gatewayObservation?.trigger === "pending-status"
        ? "Legacy pending-only policy. Redeploy the updated policy for slow-success detection."
        : "Not reported; updated policy activation is not established"],
    ["Azure observation", state?.checkedAt ? `${duration(now - state.checkedAt * 1000)} ago` : "Not refreshed"],
    ["Degradation signal", "Real POST → result GET elapsed time; overdue pending or slow successful primary operation"],
  ]);
  $("gateway-observation-state").textContent = client.gatewayObservation
    ? "Observed on real request" : "No analysis observed yet";
  const primary = matched ? state.deployment.gateway : null;
  const portal = $("key-portal-link");
  portal.href = primary?.resourceId
    ? `https://portal.azure.com/#resource${encodeURI(primary.resourceId)}`
    : "https://portal.azure.com/#browse/Microsoft.ApiManagement%2Fservice";
  portal.textContent = primary?.resourceId
    ? "Open serving APIM in Azure portal" : "Open API Management in Azure portal";
  renderRouteContext();
  renderRewriteGuide();
  if (!client.config) return;
  regionControls({ id: "gateway", label: "Gateway" }, now);
  for (const region of client.config.regions) {
    const deployed = matched ? state.deployment.regions.find((candidate) => candidate.id === region.id) : null;
    const active = client.gatewayObservation?.activeBackend;
    $(`backend-${region.id}-state`).textContent = active ? active === region.backendId ? "Last response selected" : "Not last selected" : "Not observed";
    $(`backend-${region.id}-state`).className = `badge ${active === region.backendId ? "success" : "neutral"}`;
    $(`cu-${region.id}-host`).textContent = deployed ? new URL(deployed.cuEndpoint).host : `${region.label} · deployment-managed`;
    fields($(`cu-${region.id}-fields`), [
      ["Backend identity", region.backendId], ["Azure region", region.region],
      ["CU endpoint", deployed?.cuEndpoint || "Not supplied by the control helper"],
      ["Azure resource", deployed?.foundryResourceId || "Managed by deployment"],
      ["Completion model", matched ? state.deployment.model : "Not observed"],
      ["Embedding model", matched ? state.deployment.embeddingModel : "Not observed"],
      ["Configured analyzer IDs", client.config.analyzerIds.join(", ")],
      ["Changes", "Update deployment definitions and redeploy; no runtime analyzer replication."],
    ]);
    const pinned = client.jobs.filter((job) => job.pinnedRegion?.id === region.id);
    $(`affinity-${region.id}`).textContent = pinned.length
      ? pinned.map((job) => `${job.id} · ${job.status} · ${job.pollCount} pinned GETs`).join("\n")
      : "No pinned operations yet.";
  }
}

function renderRouteContext() {
  for (const node of document.querySelectorAll(".topology .active-route")) node.classList.remove("active-route");
  const entry = client.requests.find((candidate) => candidate.id === selectedRequest);
  if (!entry) {
    $("route-context").textContent = "Select a network request to highlight its route. All deployed resources remain available below.";
    return;
  }
  const job = client.jobs.find((candidate) => candidate.id === entry.jobId);
  const region = client.config?.regions.find((candidate) => candidate.id === entry.regionId);
  const highlight = (id) => $(id).classList.add("active-route");
  highlight("client-details");
  let description;
  if (entry.kind === "Analyze") {
    highlight("apim-details");
    if (region) highlight(`cu-${region.id}-details`);
    description = `Client → single APIM → ${region?.label || "CU backend not yet reported"}. APIM chose the new-work backend. CU is gateway-reported/configured, not a browser-captured hop.`;
  } else if (entry.kind === "Poll result") {
    highlight("apim-details");
    if (region) highlight(`cu-${region.id}-details`);
    description = `Same APIM → signed accepting CU backend: ${region?.label || job?.pinnedRegion?.label || "not yet observed"}. Active new-work selection cannot move this job; the original URL is unchanged.`;
  } else {
    highlight("apim-details");
    description = "Local helper → Azure management state for the single APIM.";
    description += " Management-plane request only; no analysis is submitted or moved.";
  }
  $("route-context").textContent = `${entry.id} · ${entry.kind}${entry.jobId ? " · " + entry.jobId : ""}: ${description}`;
}

function renderFailoverTest() {
  const region = client.config && { id: "gateway", label: "Gateway" };
  const nodes = region && controlNodes.get(region.id);
  $("test-failover").disabled = !nodes || nodes.apply.disabled;
  $("reset-primary").disabled = !nodes || nodes.restoreEndpoint.disabled;
  $("restore-test-threshold").disabled = !nodes || nodes.restoreThreshold.disabled;
  $("test-failover-status").textContent = nodes
    ? `${region.label} · Management selection: ${controls.state?.activeBackend || "not observed"}. Last analysis response selection: ${client.gatewayObservation?.activeBackend || "not observed"}. Temporary test duration: ${Number(nodes.select.value) / 60} minutes. ${nodes.status.textContent}`
    : "Connect the local Azure helper to enable this real, temporary APIM setting.";
  $("test-failover-status").classList.toggle("error-note", Boolean(nodes?.status.classList.contains("error-note")));
}

function render() {
  $("key-state").textContent = client.hasKey ? "Key in memory" : "Key not set";
  $("key-state").className = `badge ${client.hasKey ? "success" : "warning"}`;
  $("key-title").textContent = client.hasKey ? "APIM subscription key is ready" : "Before you start: add your APIM subscription key";
  $("key-summary").textContent = client.hasKey
    ? "In memory for this tab only. Expand to change or clear it."
    : "Required to submit analyses and poll results. Add the key before starting the lab.";
  $("submit-button").disabled = !client.config || !client.hasKey || submitting;
  if (client.config) {
    renderConfig();
  }
  renderJobs(Date.now());
  renderTrace(Date.now());
  renderResources(Date.now());
  renderFailoverTest();
  renderTimeline();
  if (selectedJob) renderDetails();
}

window.addEventListener("pagehide", () => {
  client.clearKey();
});
setInterval(() => { render(); }, 1_000);
setInterval(() => { if (controls.state?.enabled) void refreshControls({ automatic: true }); }, 15_000);
$("document-url").value = SAMPLE_DOCUMENT_URL;
fillConfig(DEFAULT_CONFIG);
async function initialize() {
  try {
    const state = await controls.refresh();
    if (state.enabled) {
      fillConfig(state.config);
      client.configure(state.config);
    }
  } catch {
    $("control-error").textContent = "Local Azure helper unavailable. Start the loopback helper for real controls, or configure endpoints manually.";
  } finally { scheduleRender(); }
}
void initialize();
render();
