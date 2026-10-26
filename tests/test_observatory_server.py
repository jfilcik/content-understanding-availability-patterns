import copy
from http.client import HTTPConnection
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from serve_observatory import ArmClient, AzureControls, ControlError, WorkbenchServer

SUBSCRIPTION = "00000000-0000-0000-0000-000000000001"
SCOPE = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/test/providers/"
GATEWAY = SCOPE + "Microsoft.ApiManagement/service/apim-a"
THRESHOLD = GATEWAY + "/namedValues/latency-threshold"
ACTIVE = GATEWAY + "/namedValues/active-backend"
LEGACY_TM = SCOPE + "Microsoft.Network/trafficManagerProfiles/cu-test"
ROOT = Path(__file__).resolve().parents[1]


def outputs():
    values = {
        "gatewayResourceId": GATEWAY,
        "contentUnderstandingUrl": "https://a.example/contentunderstanding",
        "deployedModelName": "test-completion", "deployedEmbeddingModelName": "test-embedding",
    }
    for side, name, region in (("primary", "a", "westus"), ("secondary", "b", "eastus")):
        values.update({
            side + "Region": region,
            side + "AcuEndpoint": f"https://cu-{name}.cognitiveservices.azure.com/",
            side + "FoundryResourceId": SCOPE + "Microsoft.CognitiveServices/accounts/cu-" + name,
        })
    return {key: {"value": value} for key, value in values.items()}


class FakeArm:
    def __init__(self):
        self.resources = {
            THRESHOLD: {"etag": "one", "properties": {"value": "60", "secret": False}},
            ACTIVE: {"etag": "one", "properties": {"value": "primary-cu", "secret": False}},
        }
        self.reads = []
        self.writes = []
        self.fail_writes = False

    def request(self, method, rid, *, version=None, body=None, etag=None):
        if method == "PATCH":
            if self.fail_writes:
                raise ControlError("Synthetic ARM write failure.", 502)
            if etag != self.resources[rid].get("etag"):
                raise ControlError("Azure settings changed concurrently.", 409)
            self.writes.append((rid, copy.deepcopy(body), etag))
            self.resources[rid]["properties"].update(body["properties"])
            if "etag" in self.resources[rid]:
                self.resources[rid]["etag"] += "-next"
        else:
            self.reads.append(rid)
        result = copy.deepcopy(self.resources[rid])
        return result, result.get("etag")


class ControlFixture:
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".observatory-tests-", dir=ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "restoration.json"
        self.arm = FakeArm()
        self.now = 1000
        self.controls = self.create()

    def create(self, **kwargs):
        control = AzureControls(SUBSCRIPTION, "test", "cu-regional-ha", self.path,
                                arm=self.arm, outputs=outputs(), now=lambda: self.now, **kwargs)
        return control


class ArmClientTests(unittest.TestCase):
    def test_accepted_empty_patch_response_is_not_a_json_failure(self):
        response = MagicMock()
        response.status = 202
        response.read.return_value = b""
        response.headers.get.return_value = None
        response.__enter__.return_value = response
        opener = MagicMock()
        opener.open.return_value = response
        client = ArmClient(SUBSCRIPTION)
        client.token = "synthetic-token"
        client.expires = 10_000_000_000
        with patch("serve_observatory.build_opener", return_value=opener):
            self.assertEqual(({}, None), client.request("PATCH", THRESHOLD, body={"properties": {}}))
            with self.assertRaisesRegex(ControlError, "outcome may be unknown"):
                client.request("GET", THRESHOLD)


class ControlsTests(ControlFixture, unittest.TestCase):
    def test_single_gateway_metadata_and_two_backend_regions(self):
        state = self.controls.snapshot()
        self.assertEqual("primary-cu", state["activeBackend"])
        self.assertEqual(60, state["thresholdSeconds"])
        self.assertEqual({"resourceId": GATEWAY, "url": "https://a.example/contentunderstanding"}, state["deployment"]["gateway"])
        self.assertEqual("https://a.example/contentunderstanding", state["config"]["gatewayUrl"])
        self.assertNotIn("healthUrl", state["config"])
        self.assertEqual([
            {"id": "a", "label": "Primary", "region": "westus", "backendId": "primary-cu"},
            {"id": "b", "label": "Secondary", "region": "eastus", "backendId": "secondary-cu"},
        ], state["config"]["regions"])
        self.assertEqual(2, len(state["deployment"]["regions"]))
        self.assertEqual({THRESHOLD, ACTIVE}, set(self.arm.reads))
        self.assertNotIn("trafficManagerResourceId", state["deployment"])

    def test_threshold_has_durable_original_and_restores_only_after_expiry(self):
        result = self.controls.apply("gateway", "threshold", 300, 5)
        lease = result["leases"][0]
        self.assertEqual("60", lease["original"])
        self.assertEqual("5", self.arm.resources[lease["resourceId"]]["properties"]["value"])
        self.assertEqual("60", json.loads(self.path.read_text())["leases"][0]["original"])
        self.assertEqual(GATEWAY, json.loads(self.path.read_text())["gatewayResourceId"])
        self.assertEqual({"properties": {"value": "5"}}, self.arm.writes[0][1])
        self.assertEqual("one", self.arm.writes[0][2])
        self.now = 1299
        self.controls.restore_all(expired_only=True)
        self.assertEqual(1, len(self.controls.leases))
        self.now = 1300
        self.controls.restore_all(expired_only=True)
        self.assertEqual("60", self.arm.resources[lease["resourceId"]]["properties"]["value"])
        self.assertEqual([], json.loads(self.path.read_text())["leases"])

    def test_restart_restores_even_an_unexpired_owned_override(self):
        self.controls.apply("gateway", "threshold", 600, 5)
        recovered = self.create()
        self.assertEqual({}, recovered.leases)
        self.assertEqual("60", self.arm.resources[THRESHOLD]["properties"]["value"])

    def test_restore_preserves_external_edit_and_keeps_recovery_state(self):
        self.controls.apply("gateway", "threshold", 300, 5)
        lease = next(iter(self.controls.leases.values()))
        self.arm.resources[lease["resourceId"]]["properties"]["value"] = "17"
        with self.assertRaisesRegex(ControlError, "outside the workbench"):
            self.controls.restore("gateway", "threshold")
        self.assertEqual("17", self.arm.resources[lease["resourceId"]]["properties"]["value"])
        self.assertEqual("restore-failed", lease["status"])
        self.assertIsNotNone(self.controls.snapshot()["error"])
        self.assertTrue(self.path.exists())

    def test_ambiguous_apply_failure_retains_recovery_journal(self):
        self.arm.fail_writes = True
        with self.assertRaises(ControlError):
            self.controls.apply("gateway", "threshold", 300, 5)
        self.assertEqual("verify-required", next(iter(self.controls.leases.values()))["status"])
        self.arm.fail_writes = False
        self.controls.restore_all()
        self.assertFalse(self.controls.leases)

    def test_apply_timeout_after_azure_write_still_restores_original(self):
        original_request = self.arm.request

        def uncertain_write(method, rid, **kwargs):
            if method == "PATCH":
                self.assertEqual("60", json.loads(self.path.read_text())["leases"][0]["original"])
                original_request(method, rid, **kwargs)
                raise ControlError("Synthetic timeout after Azure accepted the change.", 502)
            return original_request(method, rid, **kwargs)

        self.arm.request = uncertain_write
        with self.assertRaisesRegex(ControlError, "timeout after Azure accepted"):
            self.controls.apply("gateway", "threshold", 300, 5)
        lease = next(iter(self.controls.leases.values()))
        self.assertEqual("5", self.arm.resources[lease["resourceId"]]["properties"]["value"])
        self.assertEqual("verify-required", lease["status"])
        self.arm.request = original_request
        self.controls.restore_all()
        self.assertEqual("60", self.arm.resources[lease["resourceId"]]["properties"]["value"])
        self.assertEqual([], json.loads(self.path.read_text())["leases"])

    def test_malformed_refresh_does_not_prevent_owned_restore(self):
        self.controls.apply("gateway", "threshold", 300, 5)
        self.arm.resources[ACTIVE]["properties"]["value"] = []
        with self.assertLogs("cu-observatory", level="ERROR"):
            self.controls.refresh()
        self.assertIsNone(self.controls.checked_at)
        self.assertIsNotNone(self.controls.snapshot()["error"])
        self.now = 1301
        self.controls.restore_all(expired_only=True)
        self.assertFalse(self.controls.leases)

    def test_manual_selection_requires_a_fresh_backend_read(self):
        original_request = self.arm.request

        def unavailable_backend(method, rid, **kwargs):
            if method == "GET" and rid == ACTIVE:
                raise ControlError("Synthetic refresh failure.", 502)
            return original_request(method, rid, **kwargs)

        self.arm.request = unavailable_backend
        with self.assertRaisesRegex(ControlError, "Synthetic refresh failure"):
            self.controls.select_backend("secondary-cu")
        self.assertEqual([], self.arm.writes)

    def test_manual_selection_is_persistent_and_never_restored_as_a_temporary_override(self):
        state = self.controls.select_backend("secondary-cu")
        self.assertEqual("secondary-cu", state["activeBackend"])
        self.assertEqual({}, self.controls.leases)
        self.assertEqual((ACTIVE, {"properties": {"value": "secondary-cu"}}, "one"), self.arm.writes[-1])
        recovered = self.create()
        recovered.restore_all()
        self.assertEqual("secondary-cu", recovered.snapshot()["activeBackend"])
        self.assertEqual("secondary-cu", self.arm.resources[ACTIVE]["properties"]["value"])
        reset = recovered.select_backend("primary-cu")
        self.assertEqual("primary-cu", reset["activeBackend"])
        self.assertEqual("one-next", self.arm.writes[-1][2])

    def test_manual_selection_preserves_threshold_lease_and_its_expiry(self):
        self.controls.apply("gateway", "threshold", 300, 5)
        saved = self.path.read_text()
        lease = copy.deepcopy(next(iter(self.controls.leases.values())))
        self.controls.select_backend("secondary-cu")
        self.assertEqual(saved, self.path.read_text())
        self.assertEqual(lease, next(iter(self.controls.leases.values())))
        self.now = 1300
        self.controls.restore_all(expired_only=True)
        self.assertEqual("60", self.arm.resources[THRESHOLD]["properties"]["value"])
        self.assertEqual("secondary-cu", self.arm.resources[ACTIVE]["properties"]["value"])

    def test_selecting_current_backend_is_a_noop(self):
        self.controls.select_backend("primary-cu")
        self.assertEqual([], self.arm.writes)

    def test_invalid_backend_inputs_never_write_azure(self):
        for backend in (None, [], {}, ["primary-cu"], True, 1, "a", "other-cu", ACTIVE):
            with self.subTest(backend=backend), self.assertRaises(ControlError):
                self.controls.select_backend(backend)
        self.assertEqual([], self.arm.writes)

    def test_invalid_inputs_never_write_azure(self):
        for args in (("x", "threshold", 300, 5), ("a", "threshold", 300, 5),
                     ("b", "threshold", 300, 5), ("gateway", "endpoint", 180, None),
                     ("gateway", "threshold", 0, 5), ("gateway", "threshold", 300, 0),
                     ("gateway", "threshold", 300, True), ("gateway", "threshold", 300, 3.5),
                     ("gateway", "threshold", 601, 5), ("gateway", "threshold", True, 5),
                     ("gateway", [], 300, 5), ({}, "threshold", 300, 5)):
            with self.subTest(args=args), self.assertRaises(ControlError):
                self.controls.apply(*args)
        self.assertEqual([], self.arm.writes)

    def test_repeated_override_cannot_replace_the_original(self):
        self.controls.apply("gateway", "threshold", 300, 5)
        with self.assertRaisesRegex(ControlError, "Restore this existing"):
            self.controls.apply("gateway", "threshold", 600, 8)
        self.assertEqual("60", next(iter(self.controls.leases.values()))["original"])

    def test_missing_apim_etag_fails_closed(self):
        del self.arm.resources[THRESHOLD]["etag"]
        with self.assertRaisesRegex(ControlError, "APIM concurrency token"):
            self.controls.apply("gateway", "threshold", 300, 5)
        self.assertEqual([], self.arm.writes)

    def test_missing_or_wildcard_backend_etag_fails_closed(self):
        for etag in (None, "", "*", " ", True):
            with self.subTest(etag=etag):
                self.arm.resources[ACTIVE]["etag"] = etag
                with self.assertRaisesRegex(ControlError, "APIM concurrency token"):
                    self.controls.select_backend("secondary-cu")
        self.assertEqual([], self.arm.writes)

    def test_concurrent_backend_edit_is_not_overwritten(self):
        original_request = self.arm.request
        def concurrent(method, rid, **kwargs):
            if method == "PATCH" and rid == ACTIVE:
                self.arm.resources[ACTIVE]["etag"] = "external-edit"
            return original_request(method, rid, **kwargs)
        self.arm.request = concurrent
        with self.assertRaisesRegex(ControlError, "changed concurrently"):
            self.controls.select_backend("secondary-cu")
        self.assertEqual([], self.arm.writes)

    def test_threshold_restore_honors_concurrent_edit_etag(self):
        self.controls.apply("gateway", "threshold", 300, 5)
        original_request = self.arm.request
        def concurrent(method, rid, **kwargs):
            if method == "PATCH" and rid == THRESHOLD:
                self.arm.resources[THRESHOLD]["etag"] = "external-edit"
                self.arm.resources[THRESHOLD]["properties"]["value"] = "17"
            return original_request(method, rid, **kwargs)
        self.arm.request = concurrent
        with self.assertRaisesRegex(ControlError, "changed concurrently"):
            self.controls.restore("gateway", "threshold")
        self.assertEqual("17", self.arm.resources[THRESHOLD]["properties"]["value"])
        self.assertEqual("restore-failed", next(iter(self.controls.leases.values()))["status"])
        self.assertEqual(1, len(self.arm.writes))

    def test_other_deployment_journal_is_not_replayed(self):
        for identity in ({"gatewayResourceId": "/other/deployment"},
                         {"trafficManagerResourceId": "/other/deployment"},
                         {"trafficManagerResourceId": LEGACY_TM.replace("/test/", "/other/")},
                         {"trafficManagerResourceId": LEGACY_TM + "/externalEndpoints/a"}):
            with self.subTest(identity=identity):
                self.path.write_text(json.dumps({**identity, "leases": []}))
                with self.assertRaisesRegex(ControlError, "another deployment"):
                    self.create()
        self.assertEqual([], self.arm.writes)

    def test_empty_owned_legacy_journal_migrates_without_azure_writes(self):
        self.path.write_text(json.dumps({"trafficManagerResourceId": LEGACY_TM, "leases": []}))
        recovered = self.create()
        self.assertEqual({}, recovered.leases)
        self.assertEqual({"gatewayResourceId": GATEWAY, "leases": []}, json.loads(self.path.read_text()))
        self.assertEqual([], self.arm.writes)

    def test_nonempty_legacy_journal_is_not_replayed(self):
        self.path.write_text(json.dumps({"trafficManagerResourceId": LEGACY_TM, "leases": [{
            "resourceId": LEGACY_TM + "/externalEndpoints/a", "regionId": "a", "kind": "endpoint",
            "original": "Enabled", "temporary": "Disabled", "expiresAt": 1300,
        }]}))
        with self.assertRaisesRegex(ControlError, "another deployment"):
            self.create()
        self.assertEqual([], self.arm.writes)

    def test_journal_cannot_target_a_signing_secret_or_arbitrary_arm_resource(self):
        self.controls.apply("gateway", "threshold", 300, 5)
        data = json.loads(self.path.read_text())
        for rid in (GATEWAY + "/namedValues/polling-signing-key", ACTIVE,
                    LEGACY_TM + "/externalEndpoints/a", THRESHOLD.replace("/test/", "/other/")):
            with self.subTest(rid=rid):
                data["leases"][0]["resourceId"] = rid
                self.path.write_text(json.dumps(data))
                with self.assertRaisesRegex(ControlError, "Invalid restoration journal"):
                    self.create()
        self.assertEqual(1, len(self.arm.writes))

    def test_malformed_journal_is_reported_cleanly_without_any_azure_write(self):
        for value in (None, [], "bad", 7, {}, {"gatewayResourceId": GATEWAY},
                      {"gatewayResourceId": GATEWAY, "leases": {}},
                      {"gatewayResourceId": GATEWAY, "leases": [None]},
                      {"gatewayResourceId": GATEWAY, "leases": [[]]},
                      {"gatewayResourceId": GATEWAY, "leases": [{"kind": []}]}):
            with self.subTest(value=value):
                self.path.write_text(json.dumps(value))
                with self.assertRaisesRegex(ControlError, "Invalid restoration journal"):
                    self.create()
        for raw in ('{"leases":', '{"gatewayResourceId":"x","leases":[],"leases":[]}', '{"leases":NaN}'):
            with self.subTest(raw=raw):
                self.path.write_text(raw)
                with self.assertRaisesRegex(ControlError, "Invalid restoration journal"):
                    self.create()
        self.assertEqual([], self.arm.writes)

    def test_all_journal_leases_are_validated_before_any_restore(self):
        self.controls.apply("gateway", "threshold", 300, 5)
        data = json.loads(self.path.read_text())
        lease = data["leases"][0]
        for field, value in (("kind", []), ("regionId", "a"), ("original", "0"),
                             ("original", "\u00b2"), ("original", []),
                             ("temporary", "301"), ("temporary", "0"), ("temporary", {}),
                             ("expiresAt", True), ("expiresAt", -1), ("expiresAt", "1300"),
                             ("expiresAt", 1e309), ("expiresAt", 10 ** 400),
                             ("status", []), ("status", "unknown"),
                             ("error", {})):
            with self.subTest(field=field, value=value):
                invalid = {**lease, field: value}
                self.path.write_text(json.dumps({**data, "leases": [lease, invalid]}))
                with self.assertRaisesRegex(ControlError, "Invalid restoration journal"):
                    self.create()
        self.path.write_text(json.dumps({**data, "leases": [lease, lease]}))
        with self.assertRaisesRegex(ControlError, "Invalid restoration journal"):
            self.create()
        self.assertEqual(1, len(self.arm.writes))
        self.assertEqual("5", self.arm.resources[THRESHOLD]["properties"]["value"])

    def test_gateway_outputs_cannot_select_an_arbitrary_arm_target(self):
        for rid in (GATEWAY.replace("/test/", "/other/"), GATEWAY + "/namedValues/secret",
                    SCOPE + "Microsoft.CognitiveServices/accounts/cu-a",
                    GATEWAY + "?api-version=x", GATEWAY + "#other"):
            with self.subTest(rid=rid):
                data = outputs()
                data["gatewayResourceId"]["value"] = rid
                with self.assertRaises(ControlError):
                    AzureControls(SUBSCRIPTION, "test", "cu-regional-ha", self.path,
                                  arm=self.arm, outputs=data, now=lambda: self.now)
        self.assertEqual([], self.arm.writes)


class HttpControlsTests(ControlFixture, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.server = WorkbenchServer(0, self.controls)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        self.addCleanup(connection.close)
        headers = {"Host": f"127.0.0.1:{self.server.server_port}", **(headers or {})}
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()

    def test_local_read_has_no_azure_tokens_or_serving_keys(self):
        status, headers, payload = self.request("GET", "/api/control/state")
        self.assertEqual(200, status)
        data = json.loads(payload)
        self.assertTrue(data["csrfToken"])
        self.assertEqual("no-store", headers["Cache-Control"])
        self.assertNotIn("accessToken", payload.decode())
        self.assertNotIn("primaryKey", payload.decode())

    def test_cross_origin_and_rebinding_hosts_are_rejected(self):
        for headers in ({"Host": "attacker.example"}, {"Origin": "https://attacker.example"},
                        {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                self.assertEqual(403, self.request("GET", "/api/control/state", headers=headers)[0])

    def test_missing_or_invalid_control_token_cannot_mutate(self):
        for token in ("", "wrong"):
            self.assertEqual(403, self.request("POST", "/api/control/apply", body='{}',
                                             headers={"Content-Type": "application/json", "X-CU-Control-Token": token})[0])
        self.assertEqual([], self.arm.writes)

    def test_valid_control_request_applies_and_restores_without_a_serving_key(self):
        headers = {"Content-Type": "application/json", "X-CU-Control-Token": self.server.csrf}
        body = json.dumps({"regionId": "gateway", "kind": "threshold", "thresholdSeconds": 5, "durationSeconds": 300})
        self.assertEqual(200, self.request("POST", "/api/control/apply", body, headers)[0])
        self.assertEqual(200, self.request("POST", "/api/control/restore",
                                         json.dumps({"regionId": "gateway", "kind": "threshold"}), headers)[0])
        self.assertEqual({}, self.controls.leases)

    def test_valid_manual_selection_changes_backend_without_a_serving_key(self):
        headers = {"Content-Type": "application/json", "X-CU-Control-Token": self.server.csrf}
        status, _, payload = self.request("POST", "/api/control/select",
                                          json.dumps({"backendId": "secondary-cu"}), headers)
        self.assertEqual(200, status)
        self.assertEqual("secondary-cu", json.loads(payload)["activeBackend"])
        self.assertEqual({}, self.controls.leases)

    def test_manual_selection_rejects_bad_inputs_and_arbitrary_resource_targets(self):
        headers = {"Content-Type": "application/json", "X-CU-Control-Token": self.server.csrf}
        for body in ({"backendId": []}, {"backendId": {}}, {"backendId": ACTIVE},
                     {"backendId": "other-cu"}, {"backendId": "secondary-cu", "resourceId": ACTIVE}):
            with self.subTest(body=body):
                self.assertIn(self.request("POST", "/api/control/select", json.dumps(body), headers)[0], {400, 404})
        self.assertEqual([], self.arm.writes)

    def test_removed_dns_and_traffic_manager_control_routes_are_unavailable(self):
        self.assertEqual(404, self.request("GET", "/api/control/route")[0])
        headers = {"Content-Type": "application/json", "X-CU-Control-Token": self.server.csrf}
        body = json.dumps({"regionId": "a", "kind": "endpoint", "durationSeconds": 180})
        self.assertEqual(400, self.request("POST", "/api/control/apply", body, headers)[0])
        self.assertEqual([], self.arm.writes)

    def test_control_request_schema_and_size_are_bounded(self):
        headers = {"Content-Type": "application/json", "X-CU-Control-Token": self.server.csrf}
        for body in ('[]', '{"regionId":"a","kind":[]}', '{"arbitraryResourceId":"/other"}', '{"x":"' + "x" * 1100 + '"}'):
            self.assertIn(self.request("POST", "/api/control/apply", body, headers)[0], {400, 404})
        self.assertEqual([], self.arm.writes)

    def test_static_serving_does_not_expose_source_tests_or_journal(self):
        for path in ("/../scripts/deploy.py", "/.azure/restoration.json", "/server.py", "/tests/fixtures.js", "/package.json"):
            self.assertEqual(404, self.request("GET", path)[0])
        self.assertEqual(200, self.request("GET", "/")[0])


if __name__ == "__main__":
    unittest.main()
