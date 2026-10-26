using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Scripting;
using Microsoft.CodeAnalysis.Scripting;
using Newtonsoft.Json.Linq;

// Execute the expressions from the deployed XML, not a separate routing implementation.
var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
var options = ScriptOptions.Default
    .AddReferences(typeof(JObject).Assembly, typeof(Globals).Assembly)
    .AddImports("System", "System.Linq", "System.Text", "System.Text.RegularExpressions", "System.Collections.Generic");
var named = new Dictionary<string, string>
{
    ["polling-signing-key"] = new string('k', 64),
    ["cu-region"] = "region-a", ["gateway-name"] = "apim-a",
    ["gateway-url"] = "https://apim-a.azure-api.net",
    ["cu-endpoint"] = "https://cu-a.cognitiveservices.azure.com/",
    ["cu-secondary-endpoint"] = "https://cu-b.cognitiveservices.azure.com/",
    ["cu-secondary-region"] = "region-b", ["active-backend"] = "primary-cu",
    ["routing-state-url"] = "https://management.azure.com/subscriptions/test/resourceGroups/test/providers/Microsoft.ApiManagement/service/apim-a/namedValues/active-backend?api-version=2024-05-01",
    ["cu-api-version"] = "2025-11-01", ["latency-threshold"] = "60",
    ["analyzers-ready"] = "true",
    ["token-lifetime"] = "86400",
};
string Render(string file)
{
    var xml = File.ReadAllText(Path.Combine(root, "policies", file))
        .Replace("__CORS_ORIGINS__", "<origin>http://localhost:5173</origin>")
        .Replace("__CORS_ORIGIN_STRINGS__", "\"http://localhost:5173\"");
    foreach (var pair in named) xml = xml.Replace("{{" + pair.Key + "}}", pair.Value);
    return xml;
}
var api = XDocument.Parse(Render("content-understanding.xml"));
var assertions = 0;
var scripts = new Dictionary<string, Script<object>>();
void Check(bool condition, string message)
{
    assertions++;
    if (!condition) throw new Exception(message);
}
string Code(string text) => text.StartsWith("@{") ? text[2..^1] : "return " + text[2..^1] + ";";
foreach (var doc in new[] { api, XDocument.Parse(Render("switch-backend.xml")) })
{
    var expressions = doc.Descendants().SelectMany(e => e.Attributes().Select(a => a.Value)
        .Concat(e.HasElements ? Array.Empty<string>() : new[] { e.Value })).Where(t => t.StartsWith("@"));
    foreach (var expression in expressions)
    {
        var script = CSharpScript.Create<object>(Code(expression), options, typeof(Globals));
        scripts[expression] = script;
        var errors = script.Compile().Where(d => d.Severity == DiagnosticSeverity.Error).ToArray();
        Check(errors.Length == 0, "Policy expression compilation: " + string.Join("\n", errors.Select(e => e.ToString())) + "\n" + expression);
    }
}
async Task<object?> Eval(string text, Globals g)
{
    if (!text.StartsWith("@")) return text;
    if (!scripts.TryGetValue(text, out var script))
    {
        script = CSharpScript.Create<object>(Code(text), options, typeof(Globals));
        scripts[text] = script;
    }
    return (await script.RunAsync(g)).ReturnValue;
}
async Task<bool> Run(IEnumerable<XElement> elements, Globals g)
{
    foreach (var e in elements)
    {
        switch (e.Name.LocalName)
        {
            case "choose":
                var branch = e.Elements("when").FirstOrDefault(w => (bool)Eval(w.Attribute("condition")!.Value, g).GetAwaiter().GetResult()!);
                branch ??= e.Element("otherwise");
                if (branch != null && await Run(branch.Elements(), g)) return true;
                break;
            case "set-variable":
                g.context.Variables[e.Attribute("name")!.Value] = (await Eval(e.Attribute("value")!.Value, g))!;
                if (e.Attribute("name")!.Value == "elapsedSeconds" && g.ElapsedOverride.HasValue)
                    g.context.Variables["elapsedSeconds"] = g.ElapsedOverride.Value;
                break;
            case "set-backend-service":
                g.Backend = (string)(await Eval(e.Attribute("backend-id")!.Value, g))!;
                break;
            case "include-fragment":
                Check(e.Attribute("fragment-id")!.Value == "cu-switch-backend", "Unexpected fragment");
                if (await Run(XDocument.Parse(Render("switch-backend.xml")).Root!.Elements(), g)) return true;
                break;
            case "send-request":
                var headers = new StringBag();
                foreach (var header in e.Elements("set-header"))
                    headers[header.Attribute("name")!.Value] = (string)(await Eval(header.Element("value")!.Value, g))!;
                g.ArmRequests.Add(new ArmRequest(e.Element("set-method")!.Value, e.Element("set-url")!.Value,
                    headers, e.Element("set-body")?.Value));
                g.context.Variables[e.Attribute("response-variable-name")!.Value] = g.ArmResponses.Dequeue()!;
                break;
            case "cache-lookup-value":
                if (g.Cache.TryGetValue(e.Attribute("key")!.Value, out var cached) && cached.Expires > DateTimeOffset.UtcNow)
                    g.context.Variables[e.Attribute("variable-name")!.Value] = cached.Value;
                break;
            case "cache-store-value":
                g.Cache[e.Attribute("key")!.Value] = ((string)(await Eval(e.Attribute("value")!.Value, g))!, DateTimeOffset.UtcNow.AddSeconds(int.Parse(e.Attribute("duration")!.Value)));
                break;
            case "set-status":
                g.context.Response.StatusCode = Convert.ToInt32(await Eval(e.Attribute("code")!.Value, g));
                break;
            case "set-header":
                if (e.Attribute("exists-action")!.Value == "delete") g.context.Request.Headers.Remove(e.Attribute("name")!.Value);
                else g.context.Response.Headers[e.Attribute("name")!.Value] = (string)(await Eval(e.Element("value")!.Value, g))!;
                break;
            case "set-body":
                g.context.Response.Body = new Body((string)(await Eval(e.Value, g))!);
                break;
            case "set-query-parameter":
                if (e.Attribute("exists-action")!.Value == "delete") g.context.Request.Url.Query.Remove(e.Attribute("name")!.Value);
                break;
            case "return-response":
                await Run(e.Elements(), g);
                return true;
        }
    }
    return false;
}
Globals New(string method = "POST") => new()
{
    context = new Context
    {
        Request = new Request { Method = method },
        Response = new Response { StatusCode = method == "POST" ? 202 : 200 },
    },
};
async Task<string> Submit(Globals g)
{
    g.context.Response.Headers["Operation-Location"] = "https://cu-a.cognitiveservices.azure.com/contentunderstanding/analyzerResults/op-1?api-version=2025-11-01&extra=keep";
    Check(!await Run(api.Root!.Element("inbound")!.Elements(), g), "Healthy submission was rejected");
    await Run(api.Root.Element("outbound")!.Elements(), g);
    return g.context.Response.Headers["Operation-Location"];
}
Globals Poll(string url, string status)
{
    var g = New("GET");
    g.context.Request.Url = new Url(url);
    g.context.Request.OriginalUrl = new Uri(url);
    g.context.Operation.Id = "get-result";
    g.context.Request.MatchedParameters["operationId"] = new Uri(url).Segments.Last();
    g.context.Response.Body = new Body("{\"status\":\"" + status + "\",\"result\":{\"contents\":[\"unchanged\"]}}");
    return g;
}
var submission = New();
var pollingUrl = await Submit(submission);
Check(new Uri(pollingUrl).Host == "apim-a.azure-api.net", "Polling must use fixed regional host");
Check(new Uri(pollingUrl).AbsolutePath.StartsWith("/contentunderstanding/analyzerResults/"), "Polling must normalize APIM's leading API-path slash");
foreach (var path in new [] { "contentunderstanding", "/contentunderstanding/", "" })
{
    var pathSubmission = New();
    pathSubmission.context.Api.Path = path;
    var pathUrl = new Uri(await Submit(pathSubmission));
    Check(pathUrl.AbsolutePath == (path.Length == 0 ? "/analyzerResults/" : "/contentunderstanding/analyzerResults/")
        + new Uri(pollingUrl).Segments.Last(), "API path variants must produce one canonical polling path");
}
Check(pollingUrl.Contains("extra=keep&gateway-token="), "Backend query parameters must survive");
Check(!submission.context.Request.Headers.ContainsKey("Ocp-Apim-Subscription-Key"), "Client key must not reach CU");
var decodedQuery = Poll(pollingUrl, "Running");
decodedQuery.context.Request.Url.Query["gateway-token"] = Uri.UnescapeDataString(decodedQuery.context.Request.Url.Query["gateway-token"]);
Check(!await Run(api.Root!.Element("inbound")!.Elements(), decodedQuery), "An already decoded signing token must remain valid");
var normal = Poll(pollingUrl, "Running");
Check(!await Run(api.Root!.Element("inbound")!.Elements(), normal), "Valid pinned URL rejected");
Check(!normal.context.Request.Url.Query.ContainsKey("gateway-token"), "Timing token must not reach CU");
normal.ElapsedOverride = 60.0;
await Run(api.Root.Element("outbound")!.Elements(), normal);
Check(normal.ArmRequests.Count == 0, "At threshold must not trip");
Check(normal.Backend == "primary-cu", "Primary token must choose concrete primary backend");
Check(normal.context.Response.Body.Text.Contains("unchanged"), "Response body was consumed");
var slow = Poll(pollingUrl, "NotStarted");
await Run(api.Root.Element("inbound")!.Elements(), slow);
slow.ElapsedOverride = 60.001;
await Run(api.Root.Element("outbound")!.Elements(), slow);
Check(slow.ArmRequests.Count == 2, "Beyond threshold must read and conditionally persist selection without Retry-After");
Check(slow.ArmRequests[1].Method == "PATCH" && slow.ArmRequests[1].Headers["If-Match"] == "etag-1", "Switch must use the read ETag");
Check(slow.ArmRequests[1].Body == "{\"properties\":{\"value\":\"secondary-cu\"}}", "Switch must patch only the active named value");
Check(slow.context.Response.Headers["X-CU-Switch-Status"] == "accepted-awaiting-activation", "Accepted ARM write is not runtime activation proof");
Check(slow.context.Response.StatusCode == 200, "Triggering poll must remain successful");
var pinned = Poll(pollingUrl, "Succeeded");
Check(!await Run(api.Root.Element("inbound")!.Elements(), pinned), "Switch must never block polling");
pinned.ElapsedOverride = 600.0;
await Run(api.Root.Element("outbound")!.Elements(), pinned);
Check(pinned.ArmRequests.Count == 2 && pinned.Backend == "primary-cu", "Slow success switches new work without moving the successful operation");
Check(pinned.context.Response.StatusCode == 200 && pinned.context.Response.Body.Text.Contains("unchanged"), "Slow success must preserve the successful CU result");
Check(pinned.context.Response.Headers["X-CU-Degradation-Reason"] == "completion-latency", "Successful completion must identify its duration signal");
Check(pinned.context.Response.Headers["X-CU-Latency-Threshold-Seconds"] == "60", "Real responses must carry the evaluated runtime threshold");
Check(pinned.context.Response.Headers["X-CU-Trigger"] == "operation-duration", "Timing signal must not claim a synthetic health probe");
var lateSuccess = Poll(pollingUrl, "Succeeded");
await Run(api.Root.Element("inbound")!.Elements(), lateSuccess);
lateSuccess.ElapsedOverride = 600.0;
lateSuccess.context.Response.Headers["Retry-After"] = "3";
await Run(api.Root.Element("outbound")!.Elements(), lateSuccess);
Check(lateSuccess.ArmRequests.Count == 2, "Slow success qualifies regardless of Retry-After");
foreach (var state in new[] { "Running", "NotStarted", "Succeeded" })
{
    foreach (var elapsed in new[] { 59.999, 60.0, 60.001 })
    {
        var measured = Poll(pollingUrl, state);
        await Run(api.Root.Element("inbound")!.Elements(), measured);
        measured.ElapsedOverride = elapsed;
        await Run(api.Root.Element("outbound")!.Elements(), measured);
        Check(measured.ArmRequests.Count == (elapsed > 60 ? 2 : 0), "Strict POST-to-result threshold: " + state + " at " + elapsed);
        Check(measured.context.Response.StatusCode == 200 && measured.context.Response.Body.Text.Contains("unchanged"), "Duration evaluation must not consume or replace CU results");
    }
}
var timedSubmission = New();
timedSubmission.context.Timestamp = DateTime.UtcNow.AddSeconds(-65);
var timedResult = Poll(await Submit(timedSubmission), "Succeeded");
await Run(api.Root.Element("inbound")!.Elements(), timedResult);
await Run(api.Root.Element("outbound")!.Elements(), timedResult);
Check(double.Parse(timedResult.context.Response.Headers["X-CU-Elapsed-Seconds"], System.Globalization.CultureInfo.InvariantCulture) >= 65,
    "Elapsed time must come from the signed original POST arrival, not a single GET RTT or UI clock");
Check(timedResult.ArmRequests.Count == 2, "Real signed POST-to-success duration must trigger without an elapsed override");
foreach (var state in new[] { "Failed", "Canceled" })
{
    var failedResult = Poll(pollingUrl, state);
    await Run(api.Root.Element("inbound")!.Elements(), failedResult);
    failedResult.ElapsedOverride = 999;
    await Run(api.Root.Element("outbound")!.Elements(), failedResult);
    Check(failedResult.ArmRequests.Count == 0, "Failed/canceled operation is not successful-completion latency evidence");
}
foreach (var state in new[] { "Failed", "Canceled", "running" })
{
    var p = Poll(pollingUrl, state);
    await Run(api.Root.Element("inbound")!.Elements(), p);
    p.ElapsedOverride = 1.0;
    await Run(api.Root.Element("outbound")!.Elements(), p);
    Check(p.ArmRequests.Count == 0, "Fast/terminal status should not trip: " + state);
}
foreach (var variant in new[] { pollingUrl.Replace("op-1", "op-2"), pollingUrl[..^2] + "xx", pollingUrl.Split('&')[0], pollingUrl.Replace("apim-a.azure-api.net", "global.example.com") })
{
    var bad = Poll(variant, "Running");
    Check(await Run(api.Root.Element("inbound")!.Elements(), bad) && bad.context.Response.StatusCode == 400, "Invalid polling URL not rejected");
}
var wrongSubscriber = Poll(pollingUrl, "Running");
wrongSubscriber.context.Subscription.Id = "other";
Check(await Run(api.Root.Element("inbound")!.Elements(), wrongSubscriber), "Subscription binding missing");
var staleSubmission = New();
staleSubmission.context.Timestamp = DateTime.UtcNow.AddDays(-2);
var stale = Poll(await Submit(staleSubmission), "Running");
Check(await Run(api.Root.Element("inbound")!.Elements(), stale), "Expired token accepted");
var futureSubmission = New();
futureSubmission.context.Timestamp = DateTime.UtcNow.AddHours(1);
var future = Poll(await Submit(futureSubmission), "Running");
Check(await Run(api.Root.Element("inbound")!.Elements(), future), "Future timestamp accepted");
var backendFailure = New();
await Run(api.Root.Element("inbound")!.Elements(), backendFailure);
backendFailure.context.Response.StatusCode = 429;
await Run(api.Root.Element("outbound")!.Elements(), backendFailure);
Check(backendFailure.ArmRequests.Count == 2, "Backend 429 should switch new work without replaying the POST");
var backendInputError = New();
await Run(api.Root.Element("inbound")!.Elements(), backendInputError);
backendInputError.context.Response.StatusCode = 400;
await Run(api.Root.Element("outbound")!.Elements(), backendInputError);
Check(backendInputError.ArmRequests.Count == 0, "Input errors should not switch");
var transport = New();
await Run(api.Root.Element("inbound")!.Elements(), transport);
transport.context.LastError.Source = "forward-request";
await Run(api.Root.Element("on-error")!.Elements(), transport);
Check(transport.ArmRequests.Count == 2 && transport.context.Response.StatusCode == 502, "Submission transport failure contract");
Check(transport.context.Response.Headers["X-CU-Region"] == "region-a"
    && transport.context.Response.Headers["X-CU-Backend"] == "primary-cu"
    && transport.context.Response.Headers["X-CU-Active-Backend"] == "primary-cu"
    && transport.context.Response.Headers["X-CU-Switch-Status"] == "accepted-awaiting-activation",
    "Transport errors must expose their actual backend and switch outcome");
var earlyFailure = New("GET");
await Run(api.Root.Element("on-error")!.Elements(), earlyFailure);
Check(earlyFailure.context.Response.Headers["X-CU-Region"] == "unknown"
    && earlyFailure.context.Response.Headers["X-CU-Backend"] == "unknown",
    "Errors before routing must not invent a primary CU hop");
foreach (var reason in new [] { "SubscriptionKeyNotFound", "SubscriptionKeyInvalid" })
{
    var unauthorized = New();
    unauthorized.context.LastError.Reason = reason;
    await Run(api.Root.Element("on-error")!.Elements(), unauthorized);
    Check(unauthorized.context.Response.StatusCode == 401 && unauthorized.Cache.Count == 0, "Serving-key failures must stay unauthorized without degrading CU");
    Check(unauthorized.context.Response.Headers["Access-Control-Allow-Origin"] == "http://localhost:5173", "Early authentication failures need allowlisted CORS without inbound variables");
}
var unauthorizedOrigin = New();
unauthorizedOrigin.context.LastError.Reason = "SubscriptionKeyInvalid";
unauthorizedOrigin.context.Request.Headers["Origin"] = "https://attacker.example";
await Run(api.Root.Element("on-error")!.Elements(), unauthorizedOrigin);
Check(unauthorizedOrigin.context.Response.Headers["Access-Control-Allow-Origin"] == "", "Authentication errors must not reflect an untrusted origin");
var unknownOperation = New("GET");
unknownOperation.context.LastError.Reason = "OperationNotFound";
await Run(api.Root.Element("on-error")!.Elements(), unknownOperation);
Check(unknownOperation.context.Response.StatusCode == 404 && unknownOperation.Cache.Count == 0, "Unexposed operations must remain not found without degrading CU");
Check(unknownOperation.context.Response.Headers["Access-Control-Allow-Origin"] == "http://localhost:5173", "Operation matching failures need allowlisted CORS without inbound variables");
var maliciousOrigin = New();
maliciousOrigin.context.Request.Headers["Origin"] = "https://attacker.example";
await Run(api.Root.Element("inbound")!.Elements(), maliciousOrigin);
Check((string)maliciousOrigin.context.Variables["allowedOrigin"] == "", "Untrusted origin must not be reflected");
var legacy = New("PUT");
legacy.context.Operation.Id = "put-all";
Check(await Run(api.Root.Element("inbound")!.Elements(), legacy) && legacy.context.Response.StatusCode == 405, "Legacy wildcard operation must not allow analyzer mutation");
var unsupported = New();
unsupported.context.Request.Url.Query["api-version"] = "unconfigured";
Check(await Run(api.Root.Element("inbound")!.Elements(), unsupported) && unsupported.context.Response.StatusCode == 400, "Unsupported API version must fail explicitly");
var malformedStatus = Poll(pollingUrl, "mystery");
await Run(api.Root.Element("inbound")!.Elements(), malformedStatus);
await Run(api.Root.Element("outbound")!.Elements(), malformedStatus);
Check(malformedStatus.context.Response.StatusCode == 502, "Unsupported status must fail explicitly");
var restored = Poll(pollingUrl, "Succeeded");
Check(!await Run(api.Root.Element("inbound")!.Elements(), restored), "Cache reset must not break polling affinity");
var invalidBackend = New();
await Run(api.Root.Element("inbound")!.Elements(), invalidBackend);
invalidBackend.context.Response.Headers["Operation-Location"] = "https://attacker.example/contentunderstanding/analyzerResults/op-1?api-version=2025-11-01";
await Run(api.Root.Element("outbound")!.Elements(), invalidBackend);
Check(invalidBackend.context.Response.StatusCode == 502, "Unexpected CU host should fail explicitly");
foreach (var invalidLocation in new [] {
    "/contentunderstanding/analyzerResults/op-1?api-version=2025-11-01",
    "https://[invalid",
    "https://cu-a.cognitiveservices.azure.com/contentunderstanding/analyzerResults/op-1?api-version=2025-11-01-preview"
})
{
    var invalidLocationRequest = New();
    await Run(api.Root.Element("inbound")!.Elements(), invalidLocationRequest);
    invalidLocationRequest.context.Response.Headers["Operation-Location"] = invalidLocation;
    await Run(api.Root.Element("outbound")!.Elements(), invalidLocationRequest);
    Check(invalidLocationRequest.context.Response.StatusCode == 502, "Relative or malformed CU locations must be rejected");
}
named["analyzers-ready"] = "false";
var notReadyApi = XDocument.Parse(Render("content-understanding.xml"));
var beforeProvisioning = New();
Check(await Run(notReadyApi.Root!.Element("inbound")!.Elements(), beforeProvisioning)
    && beforeProvisioning.context.Response.StatusCode == 503, "Submissions must stay gated until provisioning completes");
var oldPolling = Poll(pollingUrl, "Succeeded");
Check(!await Run(notReadyApi.Root.Element("inbound")!.Elements(), oldPolling), "Redeployment gating must not block existing signed polling");
named["analyzers-ready"] = "true";
var bomRead = Poll(pollingUrl, "Running");
bomRead.ArmResponses.Clear();
bomRead.ArmResponses.Enqueue(new Response { StatusCode = 200, Headers = { ["ETag"] = "bom-etag" },
    Body = new Body("\uFEFF{\"properties\":{\"value\":\"primary-cu\"}}") });
bomRead.ArmResponses.Enqueue(new Response { StatusCode = 202 });
await Run(api.Root.Element("inbound")!.Elements(), bomRead);
bomRead.ElapsedOverride = 61;
await Run(api.Root.Element("outbound")!.Elements(), bomRead);
Check(bomRead.context.Response.Headers["X-CU-Switch-Status"] == "accepted-awaiting-activation", "ARM's UTF-8 BOM must not invalidate routing JSON");
foreach (var failure in new[] { "read-failed", "missing-etag", "invalid-routing-state", "already-secondary", "conflict", "write-failed", "write-outcome-unknown" })
{
    var request = Poll(pollingUrl, "Running");
    request.ArmResponses.Clear();
    var read = new Response { StatusCode = failure == "read-failed" ? 403 : 200,
        Body = new Body(failure == "invalid-routing-state" ? "{broken" : "{\"properties\":{\"value\":\"" + (failure == "already-secondary" ? "secondary-cu" : "primary-cu") + "\"}}") };
    if (failure != "missing-etag") read.Headers["ETag"] = "etag-failure-test";
    request.ArmResponses.Enqueue(read);
    request.ArmResponses.Enqueue(failure == "write-outcome-unknown" ? null : new Response { StatusCode = failure == "conflict" ? 412 : 403 });
    await Run(api.Root.Element("inbound")!.Elements(), request);
    request.ElapsedOverride = 61;
    await Run(api.Root.Element("outbound")!.Elements(), request);
    Check(request.context.Response.Headers["X-CU-Switch-Status"] == failure, "Explicit switch outcome: " + failure);
    Check(request.context.Response.StatusCode == 200 && request.context.Response.Body.Text.Contains("unchanged"), "Management failure must preserve a valid CU result: " + failure);
}
named["active-backend"] = "secondary-cu";
var secondaryApi = XDocument.Parse(Render("content-understanding.xml"));
var oldPrimary = Poll(pollingUrl, "Running");
await Run(secondaryApi.Root!.Element("inbound")!.Elements(), oldPrimary);
oldPrimary.ElapsedOverride = 600;
await Run(secondaryApi.Root.Element("outbound")!.Elements(), oldPrimary);
Check(oldPrimary.Backend == "primary-cu" && oldPrimary.ArmRequests.Count == 0, "Inactive primary polling must retain affinity without switching");
var oldPrimarySuccess = Poll(pollingUrl, "Succeeded");
await Run(secondaryApi.Root.Element("inbound")!.Elements(), oldPrimarySuccess);
oldPrimarySuccess.ElapsedOverride = 600;
await Run(secondaryApi.Root.Element("outbound")!.Elements(), oldPrimarySuccess);
Check(oldPrimarySuccess.Backend == "primary-cu" && oldPrimarySuccess.ArmRequests.Count == 0
    && oldPrimarySuccess.context.Response.StatusCode == 200,
    "Slow success on the inactive primary must retain its original result without another switch");
var secondarySubmission = New();
await Run(secondaryApi.Root.Element("inbound")!.Elements(), secondarySubmission);
secondarySubmission.context.Response.Headers["Operation-Location"] = "https://cu-b.cognitiveservices.azure.com/contentunderstanding/analyzerResults/op-1?api-version=2025-11-01";
await Run(secondaryApi.Root.Element("outbound")!.Elements(), secondarySubmission);
var secondaryUrl = secondarySubmission.context.Response.Headers["Operation-Location"];
Check(secondarySubmission.Backend == "secondary-cu" && new Uri(secondaryUrl).Host == new Uri(pollingUrl).Host, "New secondary work uses the same APIM hostname");
Check(secondaryUrl != pollingUrl, "Resource-specific signed URLs must differ even when operation IDs match");
var secondaryTransport = New();
await Run(secondaryApi.Root.Element("inbound")!.Elements(), secondaryTransport);
secondaryTransport.context.LastError.Source = "forward-request";
await Run(secondaryApi.Root.Element("on-error")!.Elements(), secondaryTransport);
Check(secondaryTransport.context.Response.StatusCode == 502 && secondaryTransport.ArmRequests.Count == 0
    && secondaryTransport.context.Response.Headers["X-CU-Region"] == "region-b"
    && secondaryTransport.context.Response.Headers["X-CU-Backend"] == "secondary-cu"
    && secondaryTransport.context.Response.Headers["X-CU-Active-Backend"] == "secondary-cu"
    && secondaryTransport.context.Response.Headers["X-CU-Switch-Status"] == "not-applicable",
    "Secondary forwarding failures must retain backend metadata without reverse failover");
named["active-backend"] = "primary-cu";
var secondaryPoll = Poll(secondaryUrl, "Running");
await Run(api.Root.Element("inbound")!.Elements(), secondaryPoll);
secondaryPoll.ElapsedOverride = 600;
await Run(api.Root.Element("outbound")!.Elements(), secondaryPoll);
Check(secondaryPoll.Backend == "secondary-cu" && secondaryPoll.ArmRequests.Count == 0, "Manual reset cannot move secondary jobs or reverse-failover");
var secondarySuccess = Poll(secondaryUrl, "Succeeded");
await Run(api.Root.Element("inbound")!.Elements(), secondarySuccess);
secondarySuccess.ElapsedOverride = 600;
await Run(api.Root.Element("outbound")!.Elements(), secondarySuccess);
Check(secondarySuccess.Backend == "secondary-cu" && secondarySuccess.ArmRequests.Count == 0
    && secondarySuccess.context.Response.StatusCode == 200,
    "Slow successful secondary polling after primary reset must not reverse-failover or migrate the job");
var secondaryPollFailure = Poll(secondaryUrl, "Running");
await Run(api.Root.Element("inbound")!.Elements(), secondaryPollFailure);
secondaryPollFailure.context.LastError.Source = "forward-request";
await Run(api.Root.Element("on-error")!.Elements(), secondaryPollFailure);
Check(secondaryPollFailure.context.Response.StatusCode == 502 && secondaryPollFailure.ArmRequests.Count == 0
    && secondaryPollFailure.context.Response.Headers["X-CU-Region"] == "region-b"
    && secondaryPollFailure.context.Response.Headers["X-CU-Backend"] == "secondary-cu"
    && secondaryPollFailure.context.Response.Headers["X-CU-Active-Backend"] == "primary-cu",
    "A pinned secondary GET failure must not be mislabeled as the active primary");
named["active-backend"] = "invalid";
var corruptApi = XDocument.Parse(Render("content-understanding.xml"));
var corruptPost = New();
Check(await Run(corruptApi.Root!.Element("inbound")!.Elements(), corruptPost) && corruptPost.context.Response.StatusCode == 503, "Invalid routing config must fail closed for POST");
var validPinned = Poll(pollingUrl, "Succeeded");
Check(!await Run(corruptApi.Root.Element("inbound")!.Elements(), validPinned) && validPinned.Backend == "primary-cu", "Invalid active config must not block valid pinned GETs");
named["active-backend"] = "primary-cu";
Console.WriteLine($"Passed {assertions} policy expression and behavior assertions (mock gateway; not Azure runtime validation).");

public class Globals
{
    public Context context = new();
    public double? ElapsedOverride;
    public Dictionary<string, (string Value, DateTimeOffset Expires)> Cache = new();
    public string? Backend;
    public List<ArmRequest> ArmRequests = new();
    public Queue<IResponse?> ArmResponses = new(new IResponse?[] {
        new Response { StatusCode = 200, Headers = { ["ETag"] = "etag-1" }, Body = new Body("{\"properties\":{\"value\":\"primary-cu\"}}") },
        new Response { StatusCode = 202 }
    });
}
public record ArmRequest(string Method, string Url, StringBag Headers, string? Body);
public class Context
{
    public Request Request { get; set; } = new();
    public Response Response { get; set; } = new();
    public Dictionary<string, object> Variables { get; } = new();
    public Subscription Subscription { get; } = new();
    public Api Api { get; } = new();
    public Operation Operation { get; } = new();
    public LastError LastError { get; } = new();
    public DateTime Timestamp { get; set; } = DateTime.UtcNow;
}
public class Request
{
    public string Method { get; set; } = "POST";
    public Url Url { get; set; } = new("https://global.example.com/contentunderstanding/analyzers/invoice:analyze?api-version=2025-11-01");
    public Uri OriginalUrl { get; set; } = new("https://global.example.com/contentunderstanding/analyzers/invoice:analyze?api-version=2025-11-01");
    public StringBag Headers { get; } = new() { ["Origin"] = "http://localhost:5173", ["Ocp-Apim-Subscription-Key"] = "client-key" };
    public Dictionary<string, string> MatchedParameters { get; } = new() { ["analyzerId"] = "invoice" };
}
public class Url
{
    public StringBag Query { get; } = new();
    public Url(string value)
    {
        foreach (var pair in new Uri(value).Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            Query[Uri.UnescapeDataString(parts[0])] = parts.Length > 1 ? parts[1] : "";
        }
    }
}
public interface IResponse
{
    int StatusCode { get; }
    StringBag Headers { get; }
    Body Body { get; }
}
public class Response : IResponse
{
    public int StatusCode { get; set; }
    public StringBag Headers { get; } = new();
    public Body Body { get; set; } = new("{}");
}
public class Body(string text)
{
    public string Text { get; } = text;
    public T As<T>(bool preserveContent = false) => typeof(T) == typeof(string)
        ? (T)(object)Text : Newtonsoft.Json.JsonConvert.DeserializeObject<T>(Text)!;
}
public class StringBag : Dictionary<string, string>
{
    public StringBag() : base(StringComparer.OrdinalIgnoreCase) { }
    public string GetValueOrDefault(string key, string fallback) => TryGetValue(key, out var v) ? v : fallback;
}
public class Subscription { public string Id { get; set; } = "serving-subscription"; }
public class Api { public string Path { get; set; } = "/contentunderstanding"; }
public class Operation { public string Id { get; set; } = "analyze"; }
public class LastError
{
    public string Source { get; set; } = "";
    public string Reason { get; set; } = "";
}
public static class VariablesExtensions
{
    public static T GetValueOrDefault<T>(this Dictionary<string, object> values, string key, T fallback) =>
        values.TryGetValue(key, out var value) ? (T)value : fallback;
}
