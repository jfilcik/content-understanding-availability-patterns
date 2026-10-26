# CU Observatory - local request lab

CU Observatory is the live request lab for the repository's **one APIM, two regional CU resources** example. It makes APIM's URL rewriting, signed result affinity and failover observable through real Analyze/result traffic. It is not a mock service or another deployment architecture.

Add your serving key in the prerequisite section at the top, then submit a document. The network trace is on the left; **Routes & resources** is the first/default tab in the right pane, followed by **Request inspector**. Drag the divider to give either pane more room. Analysis and polling go directly to APIM. An optional loopback-only Python helper supplies real Azure test controls; no additional Azure hosting is required.

**Before using this app:** [deploy and provision both CU stacks](../README.md#deploy). For a no-cost, no-credentials introduction, open the [architecture guide](https://jfilcik.github.io/content-understanding-availability-patterns/) and [APIM walkthrough](https://jfilcik.github.io/content-understanding-availability-patterns/single-apim-failover.html) instead. The guides also run offline when opened from a local clone. The live app creates potentially billable analyses and its enabled controls change real Azure settings.

## Start

Run these commands from the **repository root**, not from `test-app`. Python 3.10+ serves the application; Node.js/npm and .NET are not needed unless running their respective tests:

```powershell
python .\scripts\serve_observatory.py
```

Or run `npm start` from `test-app`. Open **http://127.0.0.1:5173**.

Without Azure controls, use [manual connection configuration](#manual-connection-configuration) before adding your key. For automatic deployment configuration and real controls, sign in with Azure CLI and explicitly choose the successful test deployment:

```powershell
az login
python .\scripts\serve_observatory.py --enable-azure-controls `
  --subscription <subscription-id> --resource-group <test-resource-group>
```

The default deployment name is `cu-regional-ha`; override it with `--deployment-name`. Control mode discovers the single APIM and both CU identities from successful deployment outputs. It never retrieves or returns serving/signing secrets. The prerequisite links to APIM in Azure portal: **APIs > Subscriptions > Content Understanding client > Primary key**. Enter the serving key; the field clears and section collapses. Reopen to replace or clear it. The key stays in that tab's memory; the helper uses Azure CLI, not that key.

The signed-in identity needs deployment read access and read/write access to the APIM's `latency-threshold` and `active-backend` named values. Scope it to the dedicated test resources. A serving key does not imply management-plane access.

The helper binds only to `127.0.0.1`. APIM must allow the exact browser origin, typically `http://127.0.0.1:5173`; using `localhost` requires a separate allowed origin.

## Try the lab in order

1. Start the Azure-enabled helper above and open `http://127.0.0.1:5173`. Confirm **Single APIM configured** appears. If configuration fails, correct the subscription/group/deployment name; do not guess backend endpoints.
2. In the top prerequisite, follow the portal instructions for the **Content Understanding client** APIM subscription. Paste its serving key and select **Use key for this tab**. The input clears and the section collapses; Submit now requires no readiness probe.
3. Keep the sample invoice URL and `invoice` analyzer, then select **Submit one analysis**. Wait for `Succeeded`. Select the POST and each result GET in the trace. In **Request inspector**, compare the operation ID, historical CU status and signed `Operation-Location`; in **Routes & resources > API Management**, inspect each URL rewrite. A baseline may already select secondary if a previous experiment left sticky selection there.
4. To test automatic failover, confirm new work is on primary, using **Reset to primary** if necessary. Restore any previous temporary threshold first and allow propagation. Select **Test failover · 2s**, then deliberately submit **one new** analysis. Keep polling and inspect the actual response's threshold, duration, degradation reason and switch status. A response strictly beyond 2 seconds can qualify while pending or on success; a fast operation might not trigger. Neither the button nor the animation submits work.
5. After a qualifying response and runtime propagation, deliberately submit another analysis. Confirm it is accepted by secondary through the **same APIM hostname**, while the earlier operation's GETs remain pinned to primary. An accepted management update alone is not this proof.
6. Select **Restore test threshold** and confirm restoration. Separately select **Reset to primary**, allow propagation and inspect a subsequent deliberate submission if you need runtime proof. Keep the helper running until restoration is confirmed. Stopping the browser/helper does not cancel jobs or stop Azure resource charges.

Do not loop submissions just to force a switch. Each Analyze is new work and may be billed. An over-threshold result is a degradation signal, not proof of a regional outage; polling delays are included.

## Analyze and inspect

- The document URL defaults to the [sample invoice](https://github.com/Azure-Samples/azure-ai-content-understanding-python/raw/refs/heads/main/data/invoice.pdf) and remains populated after submission. You can replace it or upload a binary file.
- Choose a deployed analyzer (`invoice` / `receipt` by default). Every deliberate submit creates a real, potentially billable CU job. No POST is automatically retried, even if its outcome is unknown.
- The trace defaults to **Analysis & polling**, with **All requests** and **Azure controls** filters. There are no synthetic health requests. Select a row for redacted URL, headers, body previews, reported region, HTTP RTT and gateway POST-to-result elapsed time. Previews are bounded to 64,000 characters and the latest 250 requests.
- **Request inspector** highlights the CU operation ID (not the local `job-###`), CU status (not HTTP status) and returned `Operation-Location`. Each is a historical response snapshot: an earlier response that reported `Running` stays `Running` even if a later poll succeeds. A POST that did not report CU status stays unreported. GETs show their unchanged requested polling URL separately, without implying they returned another `Operation-Location`.
- The signed-token placeholder shows **`[accepting Foundry resource name] hover for details`**, using the operation's observed accepting backend and the matching helper's resource identity. Without resource metadata it shows the known backend/region, never a name guessed from decoded claims. The brackets are a display label, not part of the URL sent. Hover, focus or tap for the complete token and decoded routing claims. Escape, **Hide token**, a different selected request/tab, trace clearing or key clearing removes the revealed contents. The trigger keeps keyboard focus across normal refreshes. Malformed/opaque tokens have explicit decode errors; no inspection action sends requests or retrieves the signing secret.
- Operations show gateway **POST → last GET** duration, or **POST → success** after success. Client age is shown until gateway timing is reported; retained operations distinguish time since attachment. **Details** shows the result/error and lets you explicitly copy the complete sensitive polling URL to retain privately. Clearing the trace does not remove jobs, last runtime observation or polling.
- **Routes & resources** shows the client, one APIM and two CU backends. New submissions highlight their reported accepting backend; signed polls highlight that job's pinned backend, not the active new-work destination. Expand APIM for selected-request before/after URL mappings. Backend URLs are configuration-derived illustrations, never captured CU hops or original backend response headers. Missing helper endpoint metadata produces symbolic backend identities, not guessed account hostnames. Management requests highlight APIM without inventing a CU call. Models/analyzers and resource IDs remain deployment-managed.
- Drag the divider left/right to resize the panes; with keyboard focus, use Left/Right arrows in 5-percent steps or Home/End for the 20/80-percent bounds. Double-click resets the split. The tabs support Left/Right and Home/End navigation. On narrow screens, the trace appears above the tabbed details and the divider is hidden. Operations remain below both panes.

HTTP RTT is not analysis duration. Gateway elapsed time starts at the original POST's arrival and ends at the observed result GET response, including polling gaps and client pauses. A late successful poll can qualify for duration-based failover even if CU finished earlier; it does not prove CU engine processing took that long. APIM-to-CU hops are configured/gateway-reported, not browser-captured requests.

Endpoint configuration locks after the first operation to protect its trust boundary. Retain signed polling URLs before reloading. Keys, jobs, traces, document bodies and results are not persisted in browser storage.

## One submission route and signed polling

Every POST uses the single APIM URL. Its default HTTPS certificate works; there is no DNS helper or shared-hostname workaround. APIM selects new work using `active-backend`; each returned signed URL independently binds its accepting CU resource.

GETs use the complete unchanged `Operation-Location`. The client allows only the exact configured APIM origin/API/result path and API version, without embedded credentials, fragments or credential query parameters. Redirects are rejected. A shared hostname cannot establish CU identity: the app records gateway response headers. A retained URL's region stays unknown until observed. No automatic POST retry or job migration occurs.

The token is signed, **not encrypted**. Its first component is Base64-encoded UTF-8 JSON; the second is an HMAC-SHA256 signature that APIM validates with its secret. The browser can decode claims without that secret but cannot verify them. Inspector claims are labeled unverified and never choose a network destination or establish operation age/accepting region. The inspector separates the selected response's reported backend, the operation's observed accepting backend, and any active new-work selection reported in that response; conflicting claims receive a warning.

## Temporary real controls

**Test failover · 2s** changes the single APIM's real threshold and journals its original value. Default restoration is 5 minutes, configurable to 3/5/10 minutes in the APIM card. **Restore test threshold** restores immediately. The status distinguishes management settings, gateway runtime and restoration countdown. No document is submitted by this button.

**Reset to primary**, beside the test button, uses the same persistent manual selection as the APIM card. It requires the matching helper, fresh error-free Azure state and no control action in progress; no serving key is needed for this management-only action. It resets only `active-backend`, not the threshold or job affinity. Restore the threshold separately to prevent overdue primary polling from immediately triggering another switch. Management acceptance is not runtime activation; the status displays both selections separately.

1. Restore any prior threshold override, then use **Reset to primary** if currently secondary. Wait for management confirmation and allow propagation. Actual analysis responses report the runtime selection and threshold; there is no health probe to confirm them in advance.
2. Select **Test failover · 2s**, submit once and keep polling. An actual `Succeeded`, `Running` or `NotStarted` primary GET whose signed POST-to-result duration is strictly beyond the threshold requests secondary selection. Fast success and exact-threshold results do not trip it. Pending detection remains so a stuck job need not finish first.
3. Inspect `X-CU-Degradation-Reason` (`completion-latency` / `pending-latency`) and `X-CU-Switch-Status`. An accepted ARM PATCH is still awaiting runtime activation. Compare a new same-URL submission's accepting region with the original job's pinned region. Previous observations and management reads alone do not prove the next request's destination.
4. Continue the original primary GETs through completion; new work can complete on secondary without moving the earlier operation.
5. Restore the threshold and, separately, **Reset to primary**. Threshold restoration **never resets sticky backend selection**.

The APIM card also supports editable temporary thresholds and **Select secondary manually**. Manual selection is persistent, clearly labeled, and not evidence of automatic failover. No reverse failover or automatic failback is implemented.

The helper journals the original setting before mutation in ignored `.azure/observatory-<subscription>-<group>.json`. It checks and verifies restoration and keeps failures visible and retryable. Closing a browser tab does not stop restoration. **The helper must remain running**: a stopped process or powered-off computer cannot restore Azure settings. On restart, it attempts to restore all journaled overrides, including unexpired ones. Do not delete the journal or stop the helper before restoration is confirmed.

Conflicting outside values are not overwritten. All named-value writes require fresh ETags and bounded readback confirmation. Selection is persistent and not a temporary restoration lease.

Controls are bound to the explicitly selected deployment resources and exact browser endpoint configuration. They cannot accept arbitrary resource IDs, URLs, CLI commands, keys, policy bodies or model changes. The local API validates Host/Origin/fetch metadata, requires a per-process token for writes, rejects cross-origin access, and serves only the app's public static assets. Azure tokens stay in helper memory. A local administrator or untrusted same-user process is outside this loopback boundary; use the helper only on a trusted workstation and dedicated test group.

## Real operation timing and polling

The app does not request `/health` or `/health/cu`. Its last runtime observation comes only from real Analyze/result response headers, with a request ID and observation age. Until a real request returns metadata, selection and threshold are shown as unobserved. Unsupported or missing headers are not replaced with guessed runtime values. Local Azure control-state reads remain for safe management actions and restoration; they do not probe CU or trigger failover.

APIM still rejects real submissions with `503 / GatewayNotConfigured` until the signing key, routing and analyzer provisioning are configured. The lab surfaces that POST failure explicitly and never automatically resubmits it. No synthetic readiness request gates the Submit button.

Earlier live CU API `2025-11-01` tests observed pending results without Retry-After, including primary `200 / Running` at 4.177 seconds with a temporary 2-second threshold, automatic secondary selection and original primary affinity. Those tests predate the added slow-success trigger and removal of health probes. The current duration policy uses signed age plus actual pending/successful status, not Retry-After presence; local tests cover both paths but do not establish live deployment. No synthetic polling header is added.

Polling is at least 3 seconds apart and honors `Retry-After` seconds or dates. A session is bounded to 120 polls / 30 minutes, and each HTTP request times out after 30 seconds. Stop/resume is GET-only and never cancels or resubmits work. HTTP 408/429/500/502/503/504 can retry; authentication, invalid status, malformed result, redirect and network failures pause for explicit inspection.

APIM allows exact-origin preflight and exposes `Operation-Location`, `Retry-After`, `X-CU-Region`, `X-CU-Gateway`, `X-CU-Backend`, `X-CU-Active-Backend`, `X-CU-Switch-Status`, `X-CU-Trigger`, `X-CU-Elapsed-Seconds`, `X-CU-Latency-Threshold-Seconds` and `X-CU-Degradation-Reason`. Opaque browser errors are not labeled CU outages.

Trace URLs, headers and preview bodies redact credential names, signed query values and known secrets. The deliberate token hover/focus panel is the exception: it reads the operation's already validated in-memory polling URL and shows the token only while open, without changing ordinary trace capture or persistence. Document URLs and payloads appear only in selected request/operation details, not the routing timeline. Results and decoded claims are inserted as text, never HTML. The revealed token, native browser Network panel and explicitly copied full polling URLs are sensitive; do not record or share them.

## Manual connection configuration

Deployment defaults are Sweden Central for primary/APIM and West Europe for secondary. Customers can [choose other regions before deployment](../README.md#choose-regions-before-deploying) in `main.bicepparam`. The connected helper imports the actual deployment regions and resource names automatically. Changing browser display settings does not move Azure resources or rename accounts.

Without Azure controls, open **Routes & resources**, expand the APIM and both CU cards, enter the deployment's API URL and regions, then select **Apply connections**. Display labels do not affect routing. Add the serving key separately. Or use **Import configuration JSON** in the connection tools:

```json
{
  "gatewayUrl": "https://your-apim.azure-api.net/contentunderstanding",
  "apiVersion": "2025-11-01",
  "analyzerIds": ["invoice", "receipt"],
  "regions": [
    {"id": "a", "label": "Primary", "region": "swedencentral", "backendId": "primary-cu"},
    {"id": "b", "label": "Secondary", "region": "westeurope", "backendId": "secondary-cu"}
  ]
}
```

Do not include credentials or documents. Old two-gateway configurations are rejected explicitly rather than silently selecting a region. An obsolete `healthUrl` field in older single-gateway JSON is discarded and never requested. Existing deployed diagnostic APIs are not deleted by updating the local app.

## Tests

```powershell
python -m unittest discover -s .\tests -q
npm --prefix .\test-app ci
npm --prefix .\test-app test
npm --prefix .\test-app run test:browser
```

Python tests cover management scope, restoration/restart/concurrency, persistent selection and local HTTP protections. Node covers requests, signed URL allowlisting, metadata, timing and redaction. Playwright exercises the real DOM, split/tabs/key UX, same-host routing, 2s/5s controls, sticky selection and reset using mocks.

The same browser suite covers both offline HTML guides: stage selection, playback, normal/degraded/failover states, strict timing, cross-page links, keyboard navigation, reduced motion and mobile layout. [GitHub Pages publishing](../README.md#publish-the-html-guides-with-github-pages) is separate and never hosts this live app or its Azure control helper.

Browser tests use a separate control-disabled helper on port **5174**; the live app on 5173 may remain running. Override with `CU_OBSERVATORY_TEST_PORT`. To use installed Edge, set `PLAYWRIGHT_CHANNEL=msedge`. Automated tests do not submit Azure jobs or mutate real resources, and are not proof of live Azure behavior.
