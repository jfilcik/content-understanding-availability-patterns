"""Loopback CU workbench with optional, narrowly scoped Azure test controls."""

import argparse
import atexit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
import secrets
import signal
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener

import deploy

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "test-app"
LOG = logging.getLogger("cu-observatory")
ARM = "https://management.azure.com"


class ControlError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class ArmClient:
    def __init__(self, subscription):
        self.cli = deploy.AzureCli(subscription, command_timeout=45)
        self.token = ""
        self.expires = 0

    def request(self, method, resource_id, *, version=deploy.ARM_VERSION, body=None, etag=None):
        if time.time() + 60 >= self.expires:
            result = self.cli.run("account", "get-access-token", "--resource", ARM + "/")
            if not isinstance(result, dict) or not isinstance(result.get("accessToken"), str) or not result["accessToken"]:
                raise ControlError("Azure CLI did not return a management token. Sign in with az login.", 502)
            self.token = result["accessToken"]
            self.expires = float(result.get("expires_on", time.time() + 300))
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": "application/json"}
        if etag:
            headers["If-Match"] = etag
        request = Request(ARM + resource_id + "?api-version=" + version, method=method, headers=headers,
                          data=json.dumps(body).encode() if body is not None else None)
        try:
            with build_opener(deploy.NoRedirect()).open(request, timeout=20) as response:
                payload = response.read()
                if not payload and method == "PATCH" and response.status in {200, 201, 202, 204}:
                    return {}, response.headers.get("ETag")
                value = json.loads(payload)
                if not isinstance(value, dict):
                    raise ValueError
                return value, response.headers.get("ETag") or value.get("etag")
        except HTTPError as error:
            status = error.code
            error.close()
            if status == 412:
                raise ControlError("Azure settings changed concurrently. Refresh; no concurrent edit was overwritten.", 409) from None
            raise ControlError(f"Azure management request failed (HTTP {status}). Check your signed-in identity and resource access.", 502) from None
        except (OSError, ValueError):
            raise ControlError("Azure management request failed or timed out. Its outcome may be unknown; restoration remains scheduled.", 502) from None


class AzureControls:
    def __init__(self, subscription, group, deployment_name, state_path, *, arm=None, outputs=None,
                 now=time.time):
        self.arm = arm or ArmClient(subscription)
        self.now = now
        self.lock = threading.RLock()
        self.state_path = Path(state_path)
        self.leases = {}
        self.last_error = None
        self.checked_at = None
        self.threshold = None
        self.active_backend = None
        outputs = outputs or deploy.deployment_outputs(self.arm.cli, group, deployment_name)
        self.gateway_id = deploy.output_value(outputs, "gatewayResourceId")
        self.gateway = {
            "resourceId": self.gateway_id,
            "url": deploy.output_value(outputs, "contentUnderstandingUrl"),
        }
        self.regions = []
        for index, side in enumerate(("primary", "secondary")):
            self.regions.append({
                "id": "a" if index == 0 else "b", "label": "Primary" if index == 0 else "Secondary",
                "region": deploy.output_value(outputs, side + "Region"),
                "backendId": side + "-cu", "cuEndpoint": deploy.output_value(outputs, side + "AcuEndpoint"),
                "foundryResourceId": deploy.output_value(outputs, side + "FoundryResourceId"),
            })
        expected_scope = f"/subscriptions/{subscription}/resourceGroups/{group}/providers/"
        for rid in [self.gateway_id, *(r["foundryResourceId"] for r in self.regions)]:
            if not isinstance(rid, str) or not rid.lower().startswith(expected_scope.lower()) or "?" in rid or "#" in rid:
                raise ControlError("Deployment outputs contain a resource outside the selected subscription/resource group.")
        if not re.fullmatch(re.escape(expected_scope) + r"Microsoft\.ApiManagement/service/[A-Za-z0-9-]{1,50}", self.gateway_id, re.I):
            raise ControlError("Invalid gateway resource identity.")
        self.public = {
            "subscription": subscription, "resourceGroup": group, "deploymentName": deployment_name,
            "model": deploy.output_value(outputs, "deployedModelName"),
            "embeddingModel": deploy.output_value(outputs, "deployedEmbeddingModelName"),
            "gateway": self.gateway, "regions": self.regions,
        }
        self.config = {
            "gatewayUrl": self.gateway["url"],
            "apiVersion": deploy.API_VERSION, "analyzerIds": ["invoice", "receipt"],
            "regions": [{k: region[k] for k in ("id", "label", "region", "backendId")} for region in self.regions],
        }
        self.refresh()
        if self.state_path.exists():
            try:
                data = deploy.strict_json(self.state_path.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeError):
                raise ControlError("Invalid restoration journal; no Azure settings were changed.") from None
            if not isinstance(data, dict) or not isinstance(data.get("leases"), list):
                raise ControlError("Invalid restoration journal; no Azure settings were changed.")
            legacy = ("gatewayResourceId" not in data and data["leases"] == []
                      and isinstance(data.get("trafficManagerResourceId"), str)
                      and re.fullmatch(
                          re.escape(expected_scope) + r"Microsoft\.Network/trafficManagerProfiles/[A-Za-z0-9-]{1,63}",
                          data["trafficManagerResourceId"], re.I,
                      ))
            if data.get("gatewayResourceId") != self.gateway_id and not legacy:
                raise ControlError("Restoration journal belongs to another deployment; use a separate state file.")
            leases = {}
            for lease in data["leases"]:
                self._validate_lease(lease)
                if lease["resourceId"] in leases:
                    raise ControlError("Invalid restoration journal; no Azure settings were changed.")
                leases[lease["resourceId"]] = lease
            self.leases = leases
            if legacy:
                self._save()
            self.restore_all()

    def _validate_lease(self, lease):
        valid = (isinstance(lease, dict)
                 and lease.get("kind") == "threshold" and lease.get("regionId") == "gateway"
                 and lease.get("resourceId") == self.gateway_id + "/namedValues/latency-threshold"
                 and isinstance(lease.get("original"), str) and re.fullmatch(r"[0-9]{1,10}", lease["original"])
                 and int(lease["original"]) > 0
                 and isinstance(lease.get("temporary"), str) and re.fullmatch(r"[0-9]{1,3}", lease["temporary"])
                 and 1 <= int(lease["temporary"]) <= 300
                 and type(lease.get("expiresAt")) in (int, float)
                 and 0 <= lease["expiresAt"] <= 253402300799
                 and isinstance(lease.get("status"), str)
                 and lease["status"] in {"applying", "active", "verify-required", "restore-failed"}
                 and (lease.get("error") is None or isinstance(lease["error"], str)))
        if not valid:
            raise ControlError("Invalid restoration journal; no Azure settings were changed.")

    def _save(self):
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"gatewayResourceId": self.gateway_id, "leases": list(self.leases.values())}), encoding="utf-8")
        os.replace(temporary, self.state_path)

    def _get_setting(self, lease):
        value, etag = self.arm.request("GET", lease["resourceId"])
        try:
            current = self._value(value, lease["kind"])
            if not isinstance(current, str):
                raise ValueError
            if lease["kind"] == "threshold" and (not re.fullmatch(r"[0-9]{1,10}", current) or int(current) <= 0):
                raise ValueError
            if lease["kind"] == "backend" and current not in {"primary-cu", "secondary-cu"}:
                raise ValueError
        except (KeyError, TypeError, ValueError):
            raise ControlError("Azure returned an invalid settings contract. No settings were overwritten.", 502) from None
        return value, etag

    @staticmethod
    def _value(resource, kind):
        return resource["properties"]["value"]

    def _write(self, lease, value, etag):
        if not isinstance(etag, str) or not etag.strip() or etag.strip() == "*":
            raise ControlError("Azure omitted the APIM concurrency token; refusing an unguarded settings update.", 409)
        self.arm.request("PATCH", lease["resourceId"], etag=etag, body={"properties": {"value": value}})
        deadline = time.monotonic() + 30
        while True:
            current, _ = self._get_setting(lease)
            if self._value(current, lease["kind"]) == value:
                return
            if self._value(current, lease["kind"]) not in {lease["original"], lease["temporary"]}:
                raise ControlError("Azure setting changed externally before confirmation. Recovery state was retained.", 409)
            if time.monotonic() >= deadline:
                raise ControlError("Azure accepted the update but its setting is not yet confirmed. Refresh state before another action.", 502)
            time.sleep(1)

    def apply(self, region_id, kind, duration, threshold=None):
        if type(duration) is not int or not 60 <= duration <= 600:
            raise ControlError("Temporary changes must last between 60 and 600 seconds.")
        if region_id != "gateway" or kind != "threshold":
            raise ControlError("Only the single gateway's temporary latency threshold can be changed.")
        if kind == "threshold" and (type(threshold) is not int or not 1 <= threshold <= 300):
            raise ControlError("Threshold must be a whole number from 1 to 300 seconds.")
        with self.lock:
            rid, temporary = self.gateway_id + "/namedValues/latency-threshold", str(threshold)
            if rid in self.leases:
                raise ControlError("Restore this existing temporary change before applying another.", 409)
            lease = {"resourceId": rid, "regionId": region_id, "kind": kind, "temporary": temporary}
            current, etag = self._get_setting(lease)
            original = self._value(current, kind)
            if str(original) == temporary:
                raise ControlError("This setting already has the requested value; no temporary change was made.", 409)
            lease.update(original=original, expiresAt=self.now() + duration, status="applying", error=None)
            self.leases[rid] = lease
            self._save()
            try:
                self._write(lease, temporary, etag)
                lease["status"] = "active"
                self._save()
            except (ControlError, deploy.DeploymentError):
                lease["status"] = "verify-required"
                lease["error"] = "Apply did not complete cleanly. Restoration is still scheduled; inspect or restore now."
                self._save()
                raise
            self.checked_at = None
            return self.snapshot()

    def restore(self, region_id, kind):
        with self.lock:
            lease = next((item for item in self.leases.values()
                          if item["regionId"] == region_id and item["kind"] == kind), None)
            if not lease:
                raise ControlError("There is no owned temporary change of this type to restore.", 409)
            try:
                current, etag = self._get_setting(lease)
                value = self._value(current, kind)
                if value == lease["original"]:
                    pass
                elif value == lease["temporary"]:
                    self._write(lease, lease["original"], etag)
                else:
                    raise ControlError("This setting was changed outside the workbench. Restoration is blocked to preserve that edit.", 409)
                verified, _ = self._get_setting(lease)
                if self._value(verified, kind) != lease["original"]:
                    raise ControlError("Restoration has not been confirmed in Azure; the recovery journal was retained.", 502)
                del self.leases[lease["resourceId"]]
                self._save()
                self.checked_at = None
            except (ControlError, deploy.DeploymentError) as error:
                lease["status"] = "restore-failed"
                lease["error"] = str(error)
                self._save()
                raise

    def restore_all(self, *, expired_only=False):
        failures = []
        with self.lock:
            for lease in list(self.leases.values()):
                if expired_only and lease["expiresAt"] > self.now():
                    continue
                try:
                    self.restore(lease["regionId"], lease["kind"])
                except (ControlError, deploy.DeploymentError) as error:
                    failures.append(str(error))
                    LOG.error("Temporary Azure override could not be restored: %s", error)
        if failures:
            self.last_error = "Some temporary settings could not be restored. Keep the helper running and inspect the affected resource."

    def refresh(self):
        with self.lock:
            try:
                setting, _ = self._get_setting({"kind": "threshold", "resourceId": self.gateway_id + "/namedValues/latency-threshold"})
                active, _ = self._get_setting({"kind": "backend", "resourceId": self.gateway_id + "/namedValues/active-backend"})
                self.threshold = int(setting["properties"]["value"])
                self.active_backend = active["properties"]["value"]
                self.checked_at = self.now()
                self.last_error = None
            except (ControlError, deploy.DeploymentError) as error:
                self.checked_at = None
                self.last_error = str(error)
                LOG.error("Azure control-state refresh failed: %s", error)
            except (KeyError, TypeError, ValueError):
                self.checked_at = None
                self.last_error = "Azure returned an invalid control-state contract. Restoration remains scheduled."
                LOG.error(self.last_error)

    def snapshot(self):
        with self.lock:
            restore_error = next((lease["error"] for lease in self.leases.values() if lease.get("error")), None)
            return {"enabled": True, "deployment": self.public, "config": self.config,
                    "checkedAt": self.checked_at, "error": restore_error or self.last_error,
                    "thresholdSeconds": self.threshold, "activeBackend": self.active_backend,
                    "leases": [dict(lease) for lease in self.leases.values()]}

    def select_backend(self, backend):
        if not isinstance(backend, str) or backend not in {"primary-cu", "secondary-cu"}:
            raise ControlError("Choose a configured CU backend.")
        with self.lock:
            setting = {"kind": "backend", "resourceId": self.gateway_id + "/namedValues/active-backend"}
            current, etag = self._get_setting(setting)
            original = self._value(current, "backend")
            if original != backend:
                self._write({**setting, "original": original, "temporary": backend}, backend, etag)
            self.refresh()
            return self.snapshot()


class WorkbenchServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, port, controls=None):
        self.controls = controls
        self.csrf = secrets.token_urlsafe(32)
        super().__init__(("127.0.0.1", port), WorkbenchHandler)
        self.allowed_hosts = {f"127.0.0.1:{self.server_port}", f"localhost:{self.server_port}"}


class WorkbenchHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def _json(self, status, value):
        payload = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.end_headers()
        self.wfile.write(payload)

    def _trusted(self, *, mutation=False):
        self.connection.settimeout(10)
        host = self.headers.get("Host", "")
        if host not in self.server.allowed_hosts:
            raise ControlError("Only the local workbench hostname is accepted.", 403)
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + host:
            raise ControlError("Cross-origin requests are not allowed.", 403)
        if self.headers.get("Sec-Fetch-Site", "none") not in {"same-origin", "none"}:
            raise ControlError("Cross-site requests are not allowed.", 403)
        if mutation:
            token = self.headers.get("X-CU-Control-Token", "")
            if not secrets.compare_digest(token, self.server.csrf):
                raise ControlError("Refresh the local workbench before changing Azure settings.", 403)

    def do_GET(self):
        try:
            self._trusted()
            path = urlsplit(self.path).path
            if path == "/api/control/state":
                value = self.server.controls.snapshot() if self.server.controls else {
                    "enabled": False, "error": "Azure controls are disabled. Start the helper with --enable-azure-controls, --subscription and --resource-group."
                }
                self._json(200, {**value, "csrfToken": self.server.csrf})
            elif path in {"/", "/index.html", "/app.js", "/client.js", "/core.js", "/controls.js", "/styles.css"}:
                file = STATIC / ("index.html" if path == "/" else path[1:])
                mime = "text/html" if file.suffix == ".html" else "text/css" if file.suffix == ".css" else "text/javascript"
                data = file.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mime + "; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.end_headers()
                self.wfile.write(data)
            else:
                raise ControlError("Not found.", 404)
        except ControlError as error:
            self._json(error.status, {"error": str(error)})
        except (OSError, ValueError, KeyError, deploy.DeploymentError):
            LOG.exception("Local workbench GET failed; response contents are not logged.")
            self._json(502, {"error": "Local helper could not complete the request. Check its terminal."})

    def do_POST(self):
        try:
            self._trusted(mutation=True)
            if not self.server.controls:
                raise ControlError("Azure controls are not enabled.", 409)
            if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                raise ControlError("Send a bounded JSON request.")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1024:
                raise ControlError("Control requests must be 1 to 1024 bytes.")
            body = deploy.strict_json(self.rfile.read(length).decode())
            if not isinstance(body, dict):
                raise ControlError("Control request must be a JSON object.")
            if self.path == "/api/control/apply" and set(body) <= {"regionId", "kind", "durationSeconds", "thresholdSeconds"}:
                state = self.server.controls.apply(body.get("regionId"), body.get("kind"), body.get("durationSeconds"), body.get("thresholdSeconds"))
            elif self.path == "/api/control/restore" and set(body) == {"regionId", "kind"}:
                self.server.controls.restore(body["regionId"], body["kind"])
                state = self.server.controls.snapshot()
            elif self.path == "/api/control/select" and set(body) == {"backendId"}:
                state = self.server.controls.select_backend(body["backendId"])
            else:
                raise ControlError("Unsupported local control operation.", 404)
            self._json(200, state)
        except ControlError as error:
            self._json(error.status, {"error": str(error)})
        except (ValueError, UnicodeError):
            self._json(400, {"error": "Malformed JSON control request."})
        except (OSError, KeyError, deploy.DeploymentError):
            LOG.exception("Local control action failed; credentials and service responses are not logged.")
            self._json(502, {"error": "Local Azure control action failed. Check restoration status before trying again."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5173)
    parser.add_argument("--enable-azure-controls", action="store_true")
    parser.add_argument("--subscription")
    parser.add_argument("--resource-group")
    parser.add_argument("--deployment-name", default=deploy.DEPLOYMENT_NAME)
    args = parser.parse_args()
    if args.enable_azure_controls and not all((args.subscription, args.resource_group)):
        parser.error("Azure controls require an explicit --subscription and --resource-group.")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    controls = None
    if args.enable_azure_controls:
        if not re.fullmatch(r"[a-fA-F0-9-]{36}", args.subscription) or not re.fullmatch(r"[\w.()-]{1,90}", args.resource_group):
            parser.error("Invalid subscription or resource-group value.")
        journal = ROOT / ".azure" / f"observatory-{args.subscription}-{args.resource_group}.json"
        controls = AzureControls(args.subscription, args.resource_group, args.deployment_name, journal)
    server = WorkbenchServer(args.port, controls)
    stop = threading.Event()

    def monitor():
        refresh_at = 0
        while not stop.wait(1):
            try:
                controls.restore_all(expired_only=True)
                if time.time() >= refresh_at:
                    controls.refresh()
                    refresh_at = time.time() + 15
            except OSError:
                controls.last_error = "Could not persist restoration state. Keep the helper running; restoration will be retried."
                LOG.error(controls.last_error)

    if controls:
        threading.Thread(target=monitor, name="cu-azure-controls", daemon=True).start()
        atexit.register(controls.restore_all)
    def interrupt(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    print(f"CU Observatory: http://127.0.0.1:{server.server_port} (Azure controls {'enabled' if controls else 'disabled'})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        if controls:
            controls.restore_all()


if __name__ == "__main__":
    main()
