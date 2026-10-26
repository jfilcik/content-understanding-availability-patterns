"""Local-only deployment tests. Azure CLI and all HTTP requests are fakes."""

from __future__ import annotations

import argparse
import base64
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch
from urllib.error import HTTPError, URLError
from urllib.request import Request


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cu_deploy", ROOT / "scripts" / "deploy.py")
deployment = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deployment
SPEC.loader.exec_module(deployment)

MODELS = deployment.ModelConfig("gpt-5.2", "completion-deployment",
                                "text-embedding-3-large", "embedding-deployment")
PRIMARY = "https://primary.services.ai.azure.com"
SECONDARY = "https://secondary.services.ai.azure.com"
APIM_IDS = [
    f"/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/test/providers/"
    f"Microsoft.ApiManagement/service/{name}" for name in ("primary-apim", "secondary-apim")
]
KEYS = {"primaryPollingSigningKey": "primary-signing-" + "a" * 48,
        "servingSubscriptionPrimaryKey": "serving-primary-" + "c" * 48,
        "servingSubscriptionSecondaryKey": "serving-secondary-" + "d" * 48}


def definition(base: str = "prebuilt-document") -> dict:
    return {
        "baseAnalyzerId": base,
        "models": {"completion": "${completionModel}"},
        "fieldSchema": {"name": "Test", "fields": {"Total": {"type": "number"}}},
    }


def response(status=200, body=None, headers=None):
    return deployment.HttpResult(status, headers or {}, body or {})


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def __call__(self):
        return self.now

    def sleep(self, duration):
        self.sleeps.append(duration)
        self.now += duration


class FakeHttp:
    def __init__(self):
        self.calls = []
        self.defaults = {}
        self.operations = {}
        self.poll_statuses = ["Succeeded"]
        self.put_status = 201
        self.operation_location = None
        self.retry_after = "1"
        self.supported = {"completion": [MODELS.completion], "embedding": [MODELS.embedding]}
        self.prebuilt_status = "ready"
        self.ready_status = "ready"
        self.fail_defaults = False

    def __call__(self, method, url, body, timeout):
        self.calls.append((method, url, copy.deepcopy(body), timeout))
        if "/defaults?" in url:
            if method == "GET" and not self.defaults:
                return response(400, body={"error": {"code": "InvalidRequest",
                                                     "innererror": {"code": "DefaultsNotSet"}}})
            if method == "PATCH":
                if self.fail_defaults:
                    return response(403)
                self.defaults.update(body["modelDeployments"])
            return response(body={"modelDeployments": dict(self.defaults)})
        if method == "PUT":
            analyzer_id = url.split("/analyzers/")[1].split("?")[0]
            operation = (url.split("?")[0] + "/operations/op-123?api-version=" + deployment.API_VERSION)
            self.operations[analyzer_id] = list(self.poll_statuses)
            return response(self.put_status, body={"status": "creating"},
                            headers={"operation-location": operation if self.operation_location is None
                                     else self.operation_location, "retry-after": self.retry_after})
        if "/operations/" in url:
            analyzer_id = url.split("/analyzers/")[1].split("/")[0]
            statuses = self.operations[analyzer_id]
            value = statuses.pop(0) if len(statuses) > 1 else statuses[0]
            return response(value, headers={"retry-after": self.retry_after}) if isinstance(value, int) else response(
                body={"status": value}, headers={"retry-after": self.retry_after})
        if "/analyzers/prebuilt-" in url:
            return response(body={"analyzerId": "prebuilt-document", "status": self.prebuilt_status,
                                  "supportedModels": self.supported})
        analyzer_id = url.split("/analyzers/")[1].split("?")[0]
        return response(body={"analyzerId": analyzer_id, "status": self.ready_status})


class FakeCli:
    def __init__(self):
        self.calls = []
        self.arm_calls = []
        self.old_outputs = None
        self.legacy_outputs = None
        self.functions = {}
        self.resources = []
        self.stored = {}
        self.gates = {}
        self.fail_gate = None
        self.assignments = [{"roleDefinitionId": "/providers/Microsoft.Authorization/roleDefinitions/"
                             + deployment.ROLE_ID}]
        self.permissions = [{"actions": ["*"], "notActions": []}]
        self.role_id = deployment.ROLE_ID
        self.template = {
            "parameters": {
                **{name: {"type": "secureString", "defaultValue": ""} for name in deployment.SECURE_PARAMETERS},
                "modelName": {"defaultValue": MODELS.completion},
                "modelDeploymentName": {"defaultValue": MODELS.completion_deployment},
                "embeddingModelName": {"defaultValue": MODELS.embedding},
                "embeddingDeploymentName": {"defaultValue": MODELS.embedding_deployment},
                "contentUnderstandingApiVersion": {"defaultValue": deployment.API_VERSION},
            }
        }
        self.parameters = {"primaryLocation": {"value": "westus"},
                           "secondaryLocation": {"value": "eastus"}}
        self.outputs = {
            "primaryAcuEndpoint": {"value": PRIMARY},
            "secondaryAcuEndpoint": {"value": SECONDARY},
            "primaryFoundryResourceId": {"value": APIM_IDS[0].split("/providers/")[0] + "/"
                                       "providers/Microsoft.CognitiveServices/accounts/primary"},
            "secondaryFoundryResourceId": {"value": APIM_IDS[0].split("/providers/")[0] + "/"
                                         "providers/Microsoft.CognitiveServices/accounts/secondary"},
            "gatewayResourceId": {"value": APIM_IDS[0]},
            "contentUnderstandingUrl": {"value": "https://primary-apim.azure-api.net/contentunderstanding"},
            "primaryRegion": {"value": "westus"},
            "secondaryRegion": {"value": "eastus"},
            "deployedModelName": {"value": MODELS.completion_deployment},
            "deployedEmbeddingModelName": {"value": MODELS.embedding_deployment},
        }
        self.parameter_documents = []
        self.parameter_paths = []

    def existing(self):
        self.old_outputs = copy.deepcopy(self.outputs)
        self.resources = [{"id": resource_id, "name": name} for resource_id, name in
                          zip(APIM_IDS, ("primary-apim", "secondary-apim"))]
        for region, resource_id in zip(("primary", "secondary"), APIM_IDS):
            self.stored[(resource_id, "/namedValues/polling-signing-key/listValue")] = {
                "value": KEYS["primaryPollingSigningKey"] if region == "primary" else "legacy-signing-" + "b" * 48}
            self.stored[(resource_id, "/subscriptions/" + deployment.SUBSCRIPTION_NAME + "/listSecrets")] = {
                "primaryKey": KEYS["servingSubscriptionPrimaryKey"],
                "secondaryKey": KEYS["servingSubscriptionSecondaryKey"],
            }
        self.stored[(APIM_IDS[0], "/namedValues/active-backend")] = {"properties": {"secret": False}}
        self.stored[(APIM_IDS[0], "/namedValues/active-backend/listValue")] = {"value": "secondary-cu"}
        return self

    def run(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if args[:2] == ("bicep", "build"):
            return copy.deepcopy(self.template)
        if args[:2] == ("bicep", "build-params"):
            return {"parameters": copy.deepcopy(self.parameters)}
        if args[:3] == ("role", "definition", "list"):
            return [{"name": self.role_id}]
        if args[:3] == ("role", "assignment", "list"):
            return copy.deepcopy(self.assignments)
        if args[:2] == ("group", "show"):
            return {"id": APIM_IDS[0].split("/providers/")[0]}
        if args[:3] == ("rest", "--method", "get"):
            return {"value": copy.deepcopy(self.permissions)}
        if args[:2] == ("resource", "list"):
            return copy.deepcopy(self.resources)
        if args[:3] == ("deployment", "group", "show"):
            outputs = self.legacy_outputs if args[args.index("--name") + 1] == "main" else self.old_outputs
            return {"properties": {"outputs": outputs}} if outputs is not None else None
        if args[:2] == ("functionapp", "show"):
            return self.functions.get(args[args.index("--name") + 1])
        if args[:2] == ("deployment", "group"):
            path = Path(args[args.index("--parameters") + 1][1:])
            self.parameter_paths.append(path)
            self.parameter_documents.append(json.loads(path.read_text(encoding="utf-8")))
            if args[2] == "create":
                self.old_outputs = copy.deepcopy(self.outputs)
                return {"properties": {"outputs": copy.deepcopy(self.outputs)}}
            return {}
        raise AssertionError(f"Unexpected fake CLI command {args}")

    def arm(self, method, resource_id, suffix="", **kwargs):
        self.arm_calls.append((method, resource_id, suffix))
        if suffix == "/namedValues/analyzers-ready":
            if method == "put":
                desired = kwargs["body"]["properties"]["value"]
                if self.fail_gate == (resource_id, desired):
                    raise deployment.DeploymentError("Fake gate ARM failure")
                self.gates[resource_id] = desired
                return {"properties": {"provisioningState": "InProgress"}}
            return {"properties": {"provisioningState": "Succeeded", "secret": False}}
        if suffix == "/namedValues/analyzers-ready/listValue":
            return {"value": self.gates.get(resource_id, "false")}
        return copy.deepcopy(self.stored.get((resource_id, suffix)))

    def token(self):
        return "not-a-real-token"

    def principal_id(self):
        return "00000000-0000-0000-0000-000000000001"


class LocalFiles(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix=".deployment-tests-", dir=ROOT)
        self.path = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def write(self, name="invoice", body=None):
        (self.path / (name + ".json")).write_text(json.dumps(definition() if body is None else body),
                                                 encoding="utf-8")

    def load(self):
        return deployment.load_analyzers(self.path, MODELS)


class DefinitionTests(LocalFiles):
    def test_checked_in_samples_match_ids_and_models(self):
        analyzers = deployment.load_analyzers(ROOT / "analyzers", MODELS)
        self.assertEqual(["invoice", "receipt"], [analyzer.id for analyzer in analyzers])
        for analyzer in analyzers:
            self.assertEqual("prebuilt-document", analyzer.body["baseAnalyzerId"])
            self.assertEqual(MODELS.completion, analyzer.body["models"]["completion"])

    def test_optional_matching_id_removed_from_request(self):
        body = definition()
        body["analyzerId"] = "invoice"
        self.write(body=body)
        self.assertNotIn("analyzerId", self.load()[0].body)

    def test_only_declared_exact_model_placeholders_are_rendered(self):
        body = definition()
        body["models"]["embedding"] = "${embeddingModel}"
        self.write(body=body)
        self.assertEqual(MODELS.embedding, self.load()[0].body["models"]["embedding"])

    def test_model_alias_has_mapping(self):
        body = definition()
        body["models"] = {"completion": "prebuilt-analyzer-completion",
                          "embedding": "prebuilt-analyzer-embedding"}
        self.write(body=body)
        self.assertEqual("prebuilt-analyzer-completion", self.load()[0].body["models"]["completion"])

    def test_dependencies_are_topologically_ordered(self):
        self.write("a-child", definition("z-parent"))
        self.write("z-parent")
        self.write("b-grandchild", definition("a-child"))
        self.assertEqual(["z-parent", "a-child", "b-grandchild"], [item.id for item in self.load()])

    def test_missing_dependency_rejected(self):
        self.write(body=definition("missing"))
        with self.assertRaisesRegex(deployment.DeploymentError, "Missing custom"):
            self.load()

    def test_cycle_rejected(self):
        self.write("a", definition("b"))
        self.write("b", definition("a"))
        with self.assertRaisesRegex(deployment.DeploymentError, "Cyclic"):
            self.load()

    def test_self_cycle_rejected(self):
        self.write(body=definition("invoice"))
        with self.assertRaises(deployment.DeploymentError):
            self.load()

    def test_invalid_and_reserved_ids_rejected(self):
        for name in ("bad id", "prebuilt-test", "a" * 65):
            with self.subTest(name=name):
                self.write(name)
                with self.assertRaises(deployment.DeploymentError):
                    self.load()
                (self.path / (name + ".json")).unlink()

    def test_duplicate_case_insensitive_id_rejected(self):
        # Windows cannot hold two case-only filename variants. Mock discovery to
        # exercise the cross-platform duplicate check, not a different convention.
        self.write("Invoice")
        first = self.path / "Invoice.json"
        with patch.object(Path, "rglob", return_value=[first, first]):
            with self.assertRaisesRegex(deployment.DeploymentError, "Duplicate analyzer"):
                self.load()

    def test_empty_directory_rejected(self):
        with self.assertRaises(deployment.DeploymentError):
            self.load()

    def test_nested_definitions_not_silently_ignored(self):
        (self.path / "nested").mkdir()
        (self.path / "nested" / "invoice.json").write_text(json.dumps(definition()), encoding="utf-8")
        with self.assertRaisesRegex(deployment.DeploymentError, "directly"):
            self.load()

    def test_malformed_json_duplicate_properties_and_nan_rejected(self):
        for value in ('{', '{"models":{},"models":{}}', '{"fieldSchema":NaN}'):
            with self.subTest(value=value):
                (self.path / "invoice.json").write_text(value, encoding="utf-8")
                with self.assertRaises(deployment.DeploymentError):
                    self.load()

    def test_invalid_definitions_rejected(self):
        changes = [
            {"analyzerId": "different"}, {"status": "ready"}, {"baseAnalyzerId": "../bad"},
            {"baseAnalyzerId": None}, {"models": {"completion": "gpt-imaginary"}},
            {"models": {"completion": "embedding-deployment"}},
            {"models": {"completion": "${arbitraryCode}"}}, {"models": {}},
            {"models": {"completion": "${completionModel}", "unrecognized": "gpt-5.2"}},
            {"description": "${completionModel}"}, {"dynamicFieldSchema": "true"},
            {"processingLocation": "unknown"}, {"processingLocation": []}, {"tags": {"secret": 5}},
            {"config": {"returnDetails": "true"}}, {"config": {"unknown": True}},
            {"config": {"tableFormat": []}},
            {"config": {"contentCategories": {}}},
            {"knowledgeSources": [{"kind": "labeledData"}]},
            {"fieldSchema": {}}, {"fieldSchema": {"name": "test", "fields": []}},
            {"fieldSchema": {"name": "test", "fields": {"x": {"type": "unknown"}}}},
            {"fieldSchema": {"name": "test", "fields": {"x": {"type": []}}}},
            {"fieldSchema": {"name": "test", "fields": {"x": {"type": "string", "method": []}}}},
            {"fieldSchema": {"name": "test", "fields": {"x": {"type": "array"}}}},
            {"fieldSchema": {"name": "test", "fields": {"x": {"type": "object"}}}},
            {"fieldSchema": {"name": "test", "fields": {"bad name": {"type": "string"}}}},
            {"fieldSchema": {"name": "test", "fields": {"x": {"$ref": "#/definitions/missing"}}}},
        ]
        for change in changes:
            with self.subTest(change=change):
                self.write(body={**definition(), **change})
                with self.assertRaises(deployment.DeploymentError):
                    self.load()

    def test_nested_field_schema_and_refs(self):
        body = definition()
        body["fieldSchema"] = {"name": "test", "fields": {
            "Items": {"type": "array", "items": {"type": "object", "properties": {
                "Quantity": {"type": "integer"},
                "Unit": {"$ref": "#/definitions/unit"}}}}},
            "definitions": {"unit": {"type": "string", "enum": ["kg", "lb"]}}}
        self.write(body=body)
        self.assertEqual(1, len(self.load()))

    def test_cyclic_field_reference(self):
        body = definition()
        body["fieldSchema"]["fields"] = {"x": {"$ref": "#/definitions/x"}}
        body["fieldSchema"]["definitions"] = {"x": {"$ref": "#/definitions/x"}}
        self.write(body=body)
        with self.assertRaisesRegex(deployment.DeploymentError, "cyclic"):
            self.load()


class CredentialTests(unittest.TestCase):
    def test_preserves_all_existing_keys_without_generating_anything(self):
        cli = FakeCli().existing()
        with patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("rotation")):
            actual = deployment.preserved_credentials(cli, [("primary", APIM_IDS[0])])
        self.assertEqual(KEYS, actual)
        self.assertTrue(all(call[1] == APIM_IDS[0] for call in cli.arm_calls))
        self.assertTrue(all(call[0] == "post" for call in cli.arm_calls))
        self.assertTrue(all("listValue" in call[2] or "listSecrets" in call[2] for call in cli.arm_calls))

    def test_initial_gateway_keys_are_crypto_generated(self):
        cli = FakeCli()
        actual = deployment.preserved_credentials(cli, [("primary", None)])
        self.assertEqual(set(deployment.SECURE_PARAMETERS), set(actual))
        self.assertEqual(3, len(set(actual.values())))
        self.assertTrue(all(len(value) == 64 for value in actual.values()))
        self.assertEqual([], cli.arm_calls)

    def test_retired_secondary_credentials_are_not_read_or_compared(self):
        cli = FakeCli().existing()
        cli.stored[(APIM_IDS[1], "/subscriptions/" + deployment.SUBSCRIPTION_NAME + "/listSecrets")][
            "secondaryKey"] = "different-" * 8
        with patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("rotation")):
            actual = deployment.preserved_credentials(cli, deployment.resolve_apims(cli, "test", {}))
        self.assertEqual(KEYS, actual)
        self.assertTrue(all(call[1] == APIM_IDS[0] for call in cli.arm_calls))

    def test_missing_initial_signing_value_preserves_the_existing_serving_pair(self):
        cli = FakeCli().existing()
        del cli.stored[(APIM_IDS[0], "/namedValues/polling-signing-key/listValue")]
        actual = deployment.preserved_credentials(cli, [("primary", APIM_IDS[0])])
        self.assertEqual(KEYS["servingSubscriptionPrimaryKey"], actual["servingSubscriptionPrimaryKey"])
        self.assertEqual(KEYS["servingSubscriptionSecondaryKey"], actual["servingSubscriptionSecondaryKey"])
        self.assertNotEqual(KEYS["primaryPollingSigningKey"], actual["primaryPollingSigningKey"])
        self.assertEqual(64, len(actual["primaryPollingSigningKey"]))

    def test_empty_existing_secret_is_not_silently_rotated(self):
        cli = FakeCli().existing()
        cli.stored[(APIM_IDS[0], "/namedValues/polling-signing-key/listValue")] = {"value": ""}
        with patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("rotation")):
            with self.assertRaisesRegex(deployment.DeploymentError, "invalid"):
                deployment.preserved_credentials(cli, [("primary", APIM_IDS[0])])

    def test_missing_serving_subscription_on_existing_apim_fails_without_new_keys(self):
        cli = FakeCli().existing()
        del cli.stored[(APIM_IDS[0], "/subscriptions/" + deployment.SUBSCRIPTION_NAME + "/listSecrets")]
        with patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("rotation")):
            with self.assertRaisesRegex(deployment.DeploymentError, "could not be read"):
                deployment.preserved_credentials(cli, [("primary", APIM_IDS[0])])

    def test_unreadable_existing_keys_fail_without_new_keys(self):
        cli = FakeCli().existing()
        with patch.object(cli, "arm", side_effect=deployment.DeploymentError("permission denied")):
            with self.assertRaisesRegex(deployment.DeploymentError, "refusing to generate"):
                deployment.preserved_credentials(cli, [("primary", APIM_IDS[0])])

    def test_names_preserved_from_previous_deployment_outputs(self):
        cli = FakeCli().existing()
        parameters = {}
        actual = deployment.resolve_apims(cli, "test", parameters)
        self.assertEqual([("primary", APIM_IDS[0])], actual)
        self.assertEqual({"value": "primary-apim"}, parameters["primaryApimName"])
        self.assertIn(("--name", deployment.DEPLOYMENT_NAME),
                      [args[args.index("--name"):args.index("--name") + 2]
                       for args, _ in cli.calls if "--name" in args])
        self.assertEqual({"value": "primary"}, parameters["primaryFoundryName"])
        self.assertEqual({"value": "secondary"}, parameters["secondaryFoundryName"])

    def test_foundry_names_preserved_even_after_default_naming_changes(self):
        cli = FakeCli().existing()
        primary = "foundry-existing-long-name"
        cli.old_outputs["primaryFoundryResourceId"]["value"] = (
            cli.outputs["primaryFoundryResourceId"]["value"].rsplit("/", 1)[0] + "/" + primary
        )
        parameters = {}
        deployment.resolve_apims(cli, "test", parameters)
        self.assertEqual({"value": primary}, parameters["primaryFoundryName"])
        self.assertEqual({"value": "secondary"}, parameters["secondaryFoundryName"])

    def test_conflicting_foundry_name_blocks_replacement_before_secret_access(self):
        cli = FakeCli().existing()
        for region in ("primary", "secondary"):
            with self.subTest(region=region), self.assertRaisesRegex(
                deployment.DeploymentError, "refusing resource replacement",
            ):
                deployment.resolve_apims(cli, "test", {region + "FoundryName": {"value": "replacement"}})
        self.assertEqual([], cli.arm_calls)

    def test_recorded_foundry_identity_must_match_gateway_scope(self):
        for value in ("/other/resource", "", "https://example.invalid/account",
                      APIM_IDS[0].split("/providers/")[0].replace("/resourceGroups/test", "/resourceGroups/other")
                      + "/providers/Microsoft.CognitiveServices/accounts/old",
                      "/subscriptions/other/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/old"):
            with self.subTest(value=value):
                cli = FakeCli().existing()
                cli.old_outputs["primaryFoundryResourceId"]["value"] = value
                with self.assertRaises(deployment.DeploymentError):
                    deployment.resolve_apims(cli, "test", {})
                self.assertEqual([], cli.arm_calls)

    def test_fresh_deployment_keeps_region_aware_template_names_and_explicit_names(self):
        for parameters in ({}, {"primaryFoundryName": {"value": "foundry-custom-primary"}}):
            with self.subTest(parameters=parameters):
                original = copy.deepcopy(parameters)
                deployment.resolve_apims(FakeCli(), "test", parameters)
                self.assertEqual(original, parameters)

    def test_current_foundry_outputs_take_precedence_and_accept_matching_explicit_names(self):
        cli = FakeCli().existing()
        cli.legacy_outputs = copy.deepcopy(cli.outputs)
        cli.legacy_outputs["primaryFoundryResourceId"]["value"] += "-legacy"
        parameters = {"primaryFoundryName": {"value": "PRIMARY"}, "secondaryFoundryName": {"value": "secondary"}}
        deployment.resolve_apims(cli, "test", parameters)
        self.assertEqual({"value": "primary"}, parameters["primaryFoundryName"])
        self.assertEqual({"value": "secondary"}, parameters["secondaryFoundryName"])

    def test_invalid_foundry_name_parameter_is_an_explicit_deployment_error(self):
        for value in (None, "primary", {}, {"value": 123}, {"value": None}):
            with self.subTest(value=value), self.assertRaisesRegex(
                deployment.DeploymentError, "refusing resource replacement",
            ):
                deployment.resolve_apims(FakeCli().existing(), "test", {"primaryFoundryName": value})

    def test_failed_or_canceled_deployment_without_outputs_preserves_live_keys(self):
        for state in ("Failed", "Canceled"):
            with self.subTest(state=state):
                cli = FakeCli().existing()
                original_run = cli.run

                def run(*args, **kwargs):
                    if args[:3] == ("deployment", "group", "show") and args[-1] == deployment.DEPLOYMENT_NAME:
                       return {"properties": {"outputs": None, "provisioningState": state}}
                    return original_run(*args, **kwargs)

                parameters = {"primaryApimName": {"value": "primary-apim"}}
                with patch.object(cli, "run", side_effect=run), patch("sys.stderr"), \
                       patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("rotation")):
                    with self.assertRaisesRegex(deployment.DeploymentError, "cannot be resolved safely"):
                       deployment.resolve_apims(cli, "test", {})
                    apims = deployment.resolve_apims(cli, "test", parameters)
                    self.assertEqual(KEYS, deployment.preserved_credentials(cli, apims))

    def test_null_outputs_from_successful_or_active_deployment_are_not_recovered(self):
        for state in ("Succeeded", "Running", None):
            with self.subTest(state=state), patch.object(
                FakeCli, "run", return_value={"properties": {"outputs": None, "provisioningState": state}},
            ):
                with self.assertRaisesRegex(deployment.DeploymentError, "outputs are invalid"):
                    deployment.deployment_outputs(FakeCli(), "test", deployment.DEPLOYMENT_NAME)

    def test_existing_legacy_urls_can_resolve_names(self):
        cli = FakeCli().existing()
        cli.old_outputs = {
            "primaryContentUnderstandingUrl": {"value": "https://primary-apim.azure-api.net/contentunderstanding"},
            "secondaryContentUnderstandingUrl": {"value": "https://secondary-apim.azure-api.net/contentunderstanding"},
        }
        self.assertEqual([("primary", APIM_IDS[0])], deployment.resolve_apims(cli, "test", {}))

    def test_legacy_main_deployment_outputs_resolve_apims(self):
        cli = FakeCli().existing()
        cli.old_outputs = None
        cli.legacy_outputs = {
            "primaryContentUnderstandingUrl": {"value": "https://primary-apim.azure-api.net/contentunderstanding"},
            "secondaryContentUnderstandingUrl": {"value": "https://secondary-apim.azure-api.net/contentunderstanding"},
        }
        self.assertEqual([("primary", APIM_IDS[0])], deployment.resolve_apims(cli, "test", {}))

    def test_current_deployment_names_take_precedence_over_legacy_outputs(self):
        cli = FakeCli().existing()
        cli.legacy_outputs = {"primaryApimName": {"value": "old-name"},
                              "secondaryApimName": {"value": "other-old-name"}}
        self.assertEqual([("primary", APIM_IDS[0])], deployment.resolve_apims(cli, "test", {}))

    def test_running_legacy_sync_functions_block_migration(self):
        cli = FakeCli().existing()
        cli.legacy_outputs = {"primaryReplicationFunctionAppName": {"value": "legacy-primary"},
                              "secondaryReplicationFunctionAppName": {"value": "legacy-secondary"}}
        cli.functions = {"legacy-primary": {"state": "Running"}, "legacy-secondary": {"state": "Stopped"}}
        with self.assertRaisesRegex(deployment.DeploymentError, "Explicitly stop/disable"):
            deployment.resolve_apims(cli, "test", {})
        self.assertEqual([], cli.arm_calls)
        self.assertTrue(all(args[:2] != ("functionapp", "stop") for args, _ in cli.calls))

    def test_stopped_disabled_or_removed_legacy_functions_allow_migration(self):
        for app in ({"state": "Stopped"}, {"state": "Running", "enabled": False}, None):
            with self.subTest(app=app):
                cli = FakeCli().existing()
                cli.legacy_outputs = {"primaryReplicationFunctionAppName": {"value": "legacy-primary"}}
                cli.functions = {"legacy-primary": app}
                self.assertEqual([("primary", APIM_IDS[0])],
                                 deployment.resolve_apims(cli, "test", {}))

    def test_unknown_legacy_function_state_blocks_migration(self):
        cli = FakeCli().existing()
        cli.legacy_outputs = {"primaryReplicationFunctionAppName": {"value": "legacy-primary"}}
        cli.functions = {"legacy-primary": {}}
        with self.assertRaisesRegex(deployment.DeploymentError, "not confirmed stopped"):
            deployment.resolve_apims(cli, "test", {})

    def test_unresolved_existing_resources_fail_safely(self):
        cli = FakeCli().existing()
        cli.old_outputs = {}
        with self.assertRaisesRegex(deployment.DeploymentError, "cannot be resolved safely"):
            deployment.resolve_apims(cli, "test", {})

    def test_explicit_names_support_existing_resource_migration(self):
        cli = FakeCli().existing()
        cli.old_outputs = {}
        parameters = {"primaryApimName": {"value": "primary-apim"}}
        self.assertEqual([("primary", APIM_IDS[0])],
                         deployment.resolve_apims(cli, "test", parameters))

    def test_changing_existing_apim_name_fails(self):
        with self.assertRaisesRegex(deployment.DeploymentError, "resource replacement"):
            deployment.resolve_apims(FakeCli().existing(), "test", {"primaryApimName": {"value": "new-apim"}})

    def test_initial_deployment_with_expression_names_needs_no_local_arm_eval(self):
        self.assertEqual([("primary", None)],
                         deployment.resolve_apims(FakeCli(), "test", {}))

    def test_gateway_url_output_can_resolve_the_retained_name(self):
        cli = FakeCli().existing()
        cli.old_outputs = {"contentUnderstandingUrl": cli.outputs["contentUnderstandingUrl"]}
        self.assertEqual([("primary", APIM_IDS[0])], deployment.resolve_apims(cli, "test", {}))

    def test_malformed_inventory_fails_without_reading_or_generating_keys(self):
        for resources in (None, [None], [{}], [{"name": [], "id": APIM_IDS[0]}],
                          [{"name": "primary-apim", "id": "/other/resource"}],
                          [{"name": "other-name", "id": APIM_IDS[0]}],
                          [{"name": "primary-apim", "id": APIM_IDS[0].replace("/test/", "/other/")}],
                          [{"name": "primary-apim", "id": APIM_IDS[0]}] * 2):
            with self.subTest(resources=resources):
                cli = FakeCli().existing()
                cli.resources = resources
                with patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("rotation")):
                    with self.assertRaises(deployment.DeploymentError):
                        deployment.resolve_apims(cli, "test", {})
                self.assertEqual([], cli.arm_calls)

    def test_missing_recorded_gateway_is_not_treated_as_initial_provisioning(self):
        cli = FakeCli().existing()
        cli.resources = cli.resources[1:]
        with self.assertRaisesRegex(deployment.DeploymentError, "APIM inventory"):
            deployment.resolve_apims(cli, "test", {})

    def test_recorded_gateway_in_another_scope_cannot_use_matching_inventory_name(self):
        cli = FakeCli().existing()
        cli.old_outputs["gatewayResourceId"]["value"] = APIM_IDS[0].replace("/test/", "/other/")
        with self.assertRaisesRegex(deployment.DeploymentError, "APIM inventory"):
            deployment.resolve_apims(cli, "test", {})


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.http = FakeHttp()
        self.clock = Clock()
        self.client = deployment.ContentUnderstanding(PRIMARY, lambda: "not-a-real-token",
                                                      transport=self.http, timeout=30,
                                                      clock=self.clock, sleep=self.clock.sleep)
        body = definition()
        body["models"]["completion"] = MODELS.completion
        self.analyzer = deployment.Analyzer("invoice", body)

    def test_ga_model_defaults_map_names_and_aliases_to_local_deployments(self):
        self.client.configure_models(MODELS)
        patch_call = self.http.calls[0]
        self.assertEqual("PATCH", patch_call[0])
        self.assertEqual(PRIMARY + "/contentunderstanding/defaults?api-version=2025-11-01", patch_call[1])
        self.assertEqual({"modelDeployments": {
            MODELS.completion: MODELS.completion_deployment,
            MODELS.embedding: MODELS.embedding_deployment,
            "prebuilt-analyzer-completion": MODELS.completion_deployment,
            "prebuilt-analyzer-completion-mini": MODELS.completion_deployment,
            "prebuilt-analyzer-embedding": MODELS.embedding_deployment,
        }}, patch_call[2])

    def test_fresh_account_defaults_are_written_before_their_first_read(self):
        self.client.preflight([self.analyzer], MODELS)
        self.assertFalse(any("/defaults?" in call[1] for call in self.http.calls))
        self.client.configure_models(MODELS)
        self.assertEqual(["PATCH", "GET"], [call[0] for call in self.http.calls if "/defaults?" in call[1]])

    def test_create_replace_polls_and_verifies_ready_with_explicit_allow_replace(self):
        for status in (200, 201):
            self.http.put_status = status
            self.http.poll_statuses = ["NotStarted", "Running", "Succeeded"]
            self.client.provision(self.analyzer)
        puts = [call for call in self.http.calls if call[0] == "PUT"]
        self.assertEqual(2, len(puts))
        self.assertTrue(all(call[1].endswith("&allowReplace=true") for call in puts))
        self.assertTrue(all(call[2] == self.analyzer.body for call in puts))
        self.assertTrue(all(call[0] in {"PUT", "GET"} for call in self.http.calls))
        self.assertEqual([1] * 6, self.clock.sleeps)

    def test_prebuilt_availability_and_supported_models_checked_before_mutation(self):
        self.client.preflight([self.analyzer], MODELS)
        self.assertTrue(all(call[0] == "GET" for call in self.http.calls))
        self.http.supported["completion"] = ["gpt-other"]
        with self.assertRaisesRegex(deployment.DeploymentError, "does not advertise"):
            self.client.preflight([self.analyzer], MODELS)

    def test_missing_prebuilt_model_support_is_not_assumed(self):
        self.http.supported = {}
        with self.assertRaises(deployment.DeploymentError):
            self.client.preflight([self.analyzer], MODELS)

    def test_prebuilt_not_ready_fails(self):
        self.http.prebuilt_status = "creating"
        with self.assertRaisesRegex(deployment.DeploymentError, "prebuilt analyzer is not ready"):
            self.client.preflight([self.analyzer], MODELS)

    def test_custom_base_chain_uses_prebuilt_root(self):
        child = deployment.Analyzer("child", {**self.analyzer.body, "baseAnalyzerId": "invoice"})
        self.client.preflight([self.analyzer, child], MODELS)
        prebuilt_gets = [call for call in self.http.calls if "/analyzers/prebuilt-" in call[1]]
        self.assertEqual(1, len(prebuilt_gets))

    def test_failed_canceled_unknown_and_malformed_operations_fail(self):
        for status in ("Failed", "Canceled", "Cancelled", "unknown", ""):
            with self.subTest(status=status):
                self.http.poll_statuses = [status]
                with self.assertRaises(deployment.DeploymentError):
                    self.client.provision(self.analyzer)

    def test_success_does_not_skip_readiness_verification(self):
        self.http.ready_status = "creating"
        with self.assertRaisesRegex(deployment.DeploymentError, "not ready"):
            self.client.provision(self.analyzer)

    def test_put_failure_is_not_retried_or_replayed(self):
        self.http.put_status = 403
        with self.assertRaisesRegex(deployment.DeploymentError, "HTTP 403"):
            self.client.provision(self.analyzer)
        self.assertEqual(1, len(self.http.calls))

    def test_poll_transient_errors_are_bounded_and_honor_retry_after(self):
        self.http.poll_statuses = [429, 503, "Succeeded"]
        self.http.retry_after = "3"
        self.client.provision(self.analyzer)
        self.assertEqual([3, 3, 3], self.clock.sleeps)
        self.assertEqual(1, len([call for call in self.http.calls if call[0] == "PUT"]))

    def test_deadline_bounds_never_completed_operation(self):
        self.client.timeout = 5
        self.http.poll_statuses = ["Running"]
        self.http.retry_after = "2"
        with self.assertRaisesRegex(deployment.DeploymentError, "deadline"):
            self.client.provision(self.analyzer)
        self.assertLessEqual(self.clock.now, 5)
        self.assertTrue(all(0 < call[3] <= 5 for call in self.http.calls))

    def test_retry_after_larger_than_deadline_fails_without_early_poll(self):
        self.http.retry_after = "3600"
        with self.assertRaisesRegex(deployment.DeploymentError, "deadline"):
            self.client.provision(self.analyzer)
        self.assertEqual([], self.clock.sleeps)
        self.assertEqual(1, len(self.http.calls))

    def test_poll_auth_failure_is_explicit(self):
        self.http.poll_statuses = [401]
        with self.assertRaisesRegex(deployment.DeploymentError, "HTTP 401"):
            self.client.provision(self.analyzer)

    def test_unsafe_operation_urls_rejected_before_following(self):
        suffix = "/contentunderstanding/analyzers/invoice/operations/op-123?api-version=2025-11-01"
        for url in (
            "http://primary.services.ai.azure.com" + suffix, SECONDARY + suffix,
            "https://primary.services.ai.azure.com.attacker.example" + suffix,
            "https://primary.services.ai.azure.com:444" + suffix,
            "https://attacker@primary.services.ai.azure.com" + suffix,
            PRIMARY + suffix + "#fragment", PRIMARY + suffix + "&api-version=other",
            PRIMARY + suffix.replace("2025-11-01", "2026-06-01-preview"),
            PRIMARY + suffix.replace("/invoice/", "/receipt/"),
            PRIMARY + suffix.replace("/op-123", "/.."),
            PRIMARY + suffix.replace("/op-123", "/%2e%2e"),
            PRIMARY + suffix.replace("/op-123", "/a%2fb"),
            PRIMARY + suffix.replace("/op-123", "/a\\b"),
            PRIMARY + "/unexpected/path?api-version=2025-11-01",
            "/relative" + suffix, "",
        ):
            with self.subTest(url=url):
                self.http.calls.clear()
                self.http.operation_location = url
                with self.assertRaisesRegex(deployment.DeploymentError, "unsafe/nonlocal"):
                    self.client.provision(self.analyzer)
                self.assertEqual(1, len(self.http.calls))

    def test_complete_valid_operation_url_is_preserved(self):
        url = PRIMARY + "/contentunderstanding/analyzers/invoice/operations/op-123?api-version=2025-11-01&other=value"
        self.http.operation_location = url
        self.client.provision(self.analyzer)
        self.assertEqual(url, self.http.calls[1][1])

    def test_safe_endpoints(self):
        for endpoint in ("http://primary.services.ai.azure.com", "https://arbitrary.example",
                         PRIMARY + "/contentunderstanding", PRIMARY + "?secret=key",
                         "https://username:password@primary.services.ai.azure.com", PRIMARY + "#fragment"):
            with self.subTest(endpoint=endpoint), self.assertRaises(deployment.DeploymentError):
                deployment.safe_endpoint(endpoint)

    def test_retry_after_seconds_http_date_and_invalid_values(self):
        self.assertEqual(7, deployment.retry_delay("7"))
        self.assertEqual(10, deployment.retry_delay("Thu, 01 Jan 1970 00:00:10 GMT", now=0))
        for value in (None, "", "nonsense", "NaN", "inf"):
            self.assertEqual(2, deployment.retry_delay(value))
        self.assertEqual(1, deployment.retry_delay("-1"))

    def test_real_http_path_uses_bearer_auth_and_no_redirect_handler(self):
        server_response = Mock()
        server_response.status = 200
        server_response.headers = {"Content-Type": "application/json"}
        server_response.read.return_value = b'{"status":"ready"}'
        self.client.opener = MagicMock()
        self.client.opener.open.return_value.__enter__.return_value = server_response
        self.client._http("GET", PRIMARY + "/contentunderstanding/defaults?api-version=2025-11-01", None, 5)
        request = self.client.opener.open.call_args.args[0]
        self.assertEqual("Bearer not-a-real-token", request.get_header("Authorization"))
        self.assertIsNone(request.get_header("Ocp-apim-subscription-key"))
        self.assertIsNone(deployment.NoRedirect().redirect_request(Request(PRIMARY), None, 302, "", {}, SECONDARY))

    def test_http_error_body_and_network_error_details_never_exposed(self):
        self.client.opener = Mock()
        self.client.opener.open.side_effect = HTTPError(PRIMARY, 403, "super-secret", {}, io.BytesIO(b"super-secret"))
        result = self.client._http("GET", PRIMARY, None, 5)
        self.assertEqual(403, result.status)
        self.assertEqual({}, result.body)
        self.client.opener.open.side_effect = URLError("super-secret")
        with self.assertRaises(deployment.DeploymentError) as error:
            self.client._http("GET", PRIMARY, None, 5)
        self.assertNotIn("super-secret", str(error.exception))


class ReadinessGateTests(unittest.TestCase):
    def test_opens_single_gateway_only_when_update_is_confirmed(self):
        cli = FakeCli()
        deployment.enable_analyzer_gates(cli, APIM_IDS[:1], 10)
        self.assertEqual({APIM_IDS[0]: "true"}, cli.gates)
        self.assertEqual(1, len([call for call in cli.arm_calls if call[0] == "put"]))
        self.assertEqual(1, len([call for call in cli.arm_calls if call[2].endswith("/listValue")]))

    def test_update_failure_closes_gateway_gate(self):
        cli = FakeCli()
        cli.fail_gate = (APIM_IDS[0], "true")
        with self.assertRaisesRegex(deployment.DeploymentError, "gate was closed again"):
            deployment.enable_analyzer_gates(cli, APIM_IDS[:1], 10)
        self.assertEqual({APIM_IDS[0]: "false"}, cli.gates)

    def test_uncertain_update_failure_still_closes_gateway(self):
        cli = FakeCli()
        original = cli.arm
        def uncertain(method, resource_id, suffix="", **kwargs):
            result = original(method, resource_id, suffix, **kwargs)
            if method == "put" and kwargs["body"]["properties"]["value"] == "true":
                raise deployment.DeploymentError("timeout after write")
            return result
        cli.arm = uncertain
        with self.assertRaisesRegex(deployment.DeploymentError, "gate was closed again"):
            deployment.enable_analyzer_gates(cli, APIM_IDS[:1], 10)
        self.assertEqual({APIM_IDS[0]: "false"}, cli.gates)

    def test_rollback_error_is_explicit_not_a_claim_of_closed_gates(self):
        cli = FakeCli()
        with patch.object(deployment, "set_analyzer_gate", side_effect=[
            deployment.DeploymentError("enable failed"), deployment.DeploymentError("rollback failed"),
        ]):
            with self.assertRaisesRegex(deployment.DeploymentError, "rollback could not confirm closed gates for: primary"):
                deployment.enable_analyzer_gates(cli, APIM_IDS[:1], 10)

    def test_gate_uses_gateway_resource_id_without_legacy_name_outputs(self):
        cli = FakeCli()
        self.assertEqual(APIM_IDS[:1], deployment.deployed_apim_ids(cli.outputs))
        self.assertNotIn("primaryApimName", cli.outputs)

    def test_foreign_or_non_apim_gateway_output_is_rejected(self):
        for rid in (APIM_IDS[0].replace("/test/", "/other/"),
                    APIM_IDS[0] + "/namedValues/secret", "/arbitrary/resource"):
            with self.subTest(rid=rid):
                data = FakeCli().outputs
                data["gatewayResourceId"]["value"] = rid
                with self.assertRaises(deployment.DeploymentError):
                    deployment.deployed_apim_ids(data)

    def test_async_update_is_bounded(self):
        cli = FakeCli()
        clock = Clock()
        original = cli.arm
        def arm(method, resource_id, suffix="", **kwargs):
            if method == "get":
                return {"properties": {"provisioningState": "InProgress"}}
            return original(method, resource_id, suffix, **kwargs)
        cli.arm = arm
        with self.assertRaisesRegex(deployment.DeploymentError, "deadline"):
            deployment.set_analyzer_gate(cli, APIM_IDS[0], True, 5, clock=clock, sleep=clock.sleep)
        self.assertLessEqual(clock.now, 5)

    def test_terminal_failed_update_fails(self):
        cli = FakeCli()
        original = cli.arm
        def arm(method, resource_id, suffix="", **kwargs):
            if method == "get":
                return {"properties": {"provisioningState": "Failed"}}
            return original(method, resource_id, suffix, **kwargs)
        cli.arm = arm
        with self.assertRaisesRegex(deployment.DeploymentError, "gate update failed"):
            deployment.set_analyzer_gate(cli, APIM_IDS[0], True, 5)

    def test_body_has_nonsecret_display_name_and_string_value(self):
        cli = FakeCli()
        arm = Mock(wraps=cli.arm)
        cli.arm = arm
        deployment.set_analyzer_gate(cli, APIM_IDS[0], True, 5)
        self.assertEqual({"properties": {"displayName": "analyzers-ready", "secret": False, "value": "true"}},
                         arm.call_args_list[0].kwargs["body"])


class WorkflowTests(LocalFiles):
    def setUp(self):
        super().setUp()
        self.write("a-child", definition("z-parent"))
        self.write("z-parent")
        self.parameter = self.path / "test.bicepparam"
        self.parameter.write_text("fake compiled by FakeCli", encoding="utf-8")
        self.args = argparse.Namespace(parameter_file=str(self.parameter), resource_group="test",
                                       subscription_id=None, analyzers_dir=str(self.path),
                                       validate_only=False, operation_timeout_seconds=30)
        self.cli = FakeCli()
        self.transports = []
        self.clocks = []

    def client_factory(self, endpoint, token, timeout):
        http = FakeHttp()
        clock = Clock()
        self.transports.append(http)
        self.clocks.append(clock)
        return deployment.ContentUnderstanding(endpoint, token, timeout=timeout, transport=http,
                                                clock=clock, sleep=clock.sleep)

    def run_deploy(self, factory=None):
        self.stdout = io.StringIO()
        with contextlib.redirect_stdout(self.stdout):
            deployment.deploy(self.args, cli=self.cli, client_factory=factory or self.client_factory)

    def test_full_workflow_both_regions_ordering_shared_creds_private_cleanup(self):
        self.run_deploy()
        self.assertEqual(2, len(self.transports))
        for http, endpoint in zip(self.transports, (PRIMARY, SECONDARY)):
            puts = [call for call in http.calls if call[0] == "PUT"]
            self.assertEqual(["z-parent", "a-child"],
                             [call[1].split("/analyzers/")[1].split("?")[0] for call in puts])
            self.assertTrue(all(call[1].startswith(endpoint) for call in http.calls))
            self.assertFalse(any(call[0] in {"DELETE", "POST"} for call in http.calls))
        deploy_commands = [args for args, _ in self.cli.calls if args[:3] == ("deployment", "group", "create")]
        self.assertEqual("Incremental", deploy_commands[0][-1])
        for args in deploy_commands:
            self.assertIn(deployment.DEPLOYMENT_NAME, args)
            self.assertFalse(any(key in " ".join(args) for key in KEYS.values()))
        self.assertTrue(all(not path.exists() for path in self.cli.parameter_paths))
        document = self.cli.parameter_documents[-1]["parameters"]
        self.assertTrue(all(document[name]["value"] for name in deployment.SECURE_PARAMETERS))
        self.assertNotIn("servingSubscriptionPrimaryKey", self.stdout.getvalue())
        self.assertTrue(self.cli.gates)
        self.assertEqual({APIM_IDS[0]: "true"}, self.cli.gates)

    def test_repeated_deployment_preserves_keys_and_replaces_listed_analyzers(self):
        self.cli.existing()
        with patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("rotation")):
            self.run_deploy()
            self.run_deploy()
        for document in self.cli.parameter_documents:
            self.assertEqual(KEYS, {name: document["parameters"][name]["value"]
                                    for name in deployment.SECURE_PARAMETERS})
            self.assertEqual({"value": "primary"}, document["parameters"]["primaryFoundryName"])
            self.assertEqual({"value": "secondary"}, document["parameters"]["secondaryFoundryName"])
        self.assertEqual(4, len(self.transports))
        self.assertTrue(all(len([call for call in http.calls if call[0] == "PUT"]) == 2
                            for http in self.transports))

    def test_redeployment_preserves_sticky_backend_until_manual_reset(self):
        self.cli.existing()
        for backend in ("secondary-cu", "primary-cu"):
            with self.subTest(backend=backend):
                self.cli.stored[(APIM_IDS[0], "/namedValues/active-backend/listValue")] = {"value": backend}
                self.run_deploy()
                self.assertEqual({"value": backend}, self.cli.parameter_documents[-1]["parameters"]["activeBackend"])
        self.assertTrue(all(call[1] == APIM_IDS[0] for call in self.cli.arm_calls))

    def test_initial_deployment_uses_template_backend_default(self):
        self.run_deploy()
        self.assertNotIn("activeBackend", self.cli.parameter_documents[-1]["parameters"])

    def test_invalid_or_unreadable_existing_backend_prevents_deployment(self):
        for result in (None, {}, {"value": "other"}, {"value": []}, {"value": {}}):
            with self.subTest(result=result):
                self.cli = FakeCli().existing()
                self.cli.stored[(APIM_IDS[0], "/namedValues/active-backend/listValue")] = result
                with self.assertRaisesRegex(deployment.DeploymentError, "refusing to reset routing"):
                    self.run_deploy()
                self.assertEqual([], self.cli.parameter_documents)

    def test_validate_only_does_not_read_generate_or_mutate_secrets_or_analyzers(self):
        self.args.validate_only = True
        self.cli.existing()
        with patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("secret generation")):
            self.run_deploy(factory=Mock(side_effect=AssertionError("data-plane call")))
        self.assertEqual([], self.cli.arm_calls)
        self.assertFalse(any(args[:3] == ("deployment", "group", "create") for args, _ in self.cli.calls))
        self.assertFalse(any(args[:3] == ("deployment", "group", "show") for args, _ in self.cli.calls))
        self.assertFalse(any(args[:2] == ("resource", "list") for args, _ in self.cli.calls))
        self.assertTrue(all(document["parameters"][name]["value"] == deployment.VALIDATION_VALUES[name]
                            for document in self.cli.parameter_documents for name in deployment.SECURE_PARAMETERS))
        self.assertTrue(all(not path.exists() for path in self.cli.parameter_paths))

    def test_local_definition_failure_precedes_any_azure_calls(self):
        self.write("a-child", definition("missing"))
        with self.assertRaises(deployment.DeploymentError):
            self.run_deploy()
        self.assertEqual([("bicep", "build"), ("bicep", "build-params")],
                         [args[:2] for args, _ in self.cli.calls])
        self.assertEqual([], self.cli.arm_calls)

    def test_distinct_regions_checked_locally(self):
        self.cli.parameters["primaryLocation"]["value"] = "West US"
        self.cli.parameters["secondaryLocation"]["value"] = "westus"
        with self.assertRaisesRegex(deployment.DeploymentError, "must be different"):
            self.run_deploy()
        self.assertEqual(2, len(self.cli.calls))

    def test_unknown_api_and_models_rejected_locally(self):
        for parameter, value in (("contentUnderstandingApiVersion", "2026-06-01-preview"),
                                 ("modelName", "unrecognized-model")):
            with self.subTest(parameter=parameter):
                self.cli = FakeCli()
                self.cli.parameters[parameter] = {"value": value}
                with self.assertRaises(deployment.DeploymentError):
                    self.run_deploy()
                self.assertEqual(2, len(self.cli.calls))

    def test_expected_builtin_role_is_verified(self):
        self.cli.role_id = "unexpected"
        with self.assertRaisesRegex(deployment.DeploymentError, "must resolve"):
            self.run_deploy()
        self.assertEqual([], self.cli.arm_calls)
        self.assertFalse(any(args[:3] == ("deployment", "group", "create") for args, _ in self.cli.calls))

    def test_missing_iam_rights_stop_before_secret_reads_and_arm_deployment(self):
        self.cli.existing()
        self.cli.permissions = [{"actions": ["*"], "notActions": ["Microsoft.Authorization/*/Write"]}]
        for validate_only in (False, True):
            with self.subTest(validate_only=validate_only):
                self.args.validate_only = validate_only
                with patch.object(deployment.secrets, "token_hex", side_effect=AssertionError("secret generation")):
                    with self.assertRaisesRegex(deployment.DeploymentError, "roleAssignments/write"):
                        self.run_deploy()
        self.assertEqual([], self.cli.arm_calls)
        self.assertEqual([], self.cli.parameter_paths)
        self.assertFalse(any(args[:2] == ("deployment", "group") for args, _ in self.cli.calls))

    def test_explicit_case_insensitive_iam_grant_can_complement_contributor(self):
        self.cli.permissions = [
            {"actions": ["*"], "notActions": ["Microsoft.Authorization/*/Write"]},
            {"actions": ["MICROSOFT.AUTHORIZATION/ROLEASSIGNMENTS/WRITE"], "notActions": []},
        ]
        self.args.validate_only = True
        self.run_deploy()
        self.assertIn("effective IAM permissions", self.stdout.getvalue())

    def test_malformed_iam_response_fails_closed(self):
        self.cli.permissions = [{"actions": "*", "notActions": []}]
        with self.assertRaisesRegex(deployment.DeploymentError, "invalid IAM action patterns"):
            self.run_deploy()
        self.assertEqual([], self.cli.parameter_paths)

    def test_iam_permission_pagination_can_find_a_later_grant(self):
        scope = APIM_IDS[0].split("/providers/")[0]
        next_page = ("https://management.azure.com" + scope
                     + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01&skiptoken=next")
        cli = Mock()
        cli.run.side_effect = [
            {"id": scope},
            {"value": [{"actions": ["*/read"], "notActions": []}], "nextLink": next_page},
            {"value": [{"actions": ["Microsoft.Authorization/*"], "notActions": []}]},
        ]
        deployment.require_role_assignment_permission(cli, "test")
        self.assertEqual(next_page, cli.run.call_args.args[-1])

    def test_iam_permission_pagination_rejects_foreign_urls_and_cycles(self):
        scope = APIM_IDS[0].split("/providers/")[0]
        first = ("https://management.azure.com" + scope
                 + "/providers/Microsoft.Authorization/permissions?api-version=2022-04-01")
        for next_page in ("https://example.invalid/permissions", first):
            with self.subTest(next_page=next_page):
                cli = Mock()
                cli.run.side_effect = [{"id": scope}, {"value": [], "nextLink": next_page}]
                with self.assertRaisesRegex(deployment.DeploymentError, "invalid IAM permission pagination"):
                    deployment.require_role_assignment_permission(cli, "test")
                self.assertEqual(2, cli.run.call_count)

    def test_deployment_principal_requires_data_plane_role(self):
        self.cli.assignments = []
        with self.assertRaisesRegex(deployment.DeploymentError, "identity needs Cognitive Services User"):
            self.run_deploy()
        self.assertEqual([], self.transports)

    def test_direct_data_plane_role_checks_do_not_resolve_names_through_graph(self):
        self.run_deploy()
        calls = [args for args, _ in self.cli.calls if args[:3] == ("role", "assignment", "list")]
        self.assertEqual(2, len(calls))
        for args in calls:
            self.assertIn("--assignee-object-id", args)
            self.assertNotIn("--assignee", args)
            self.assertEqual("false", args[args.index("--fill-principal-name") + 1])
            self.assertEqual("false", args[args.index("--fill-role-definition-name") + 1])

    def test_second_region_preflight_failure_precedes_all_data_plane_writes(self):
        def factory(endpoint, token, timeout):
            client = self.client_factory(endpoint, token, timeout)
            if endpoint == SECONDARY:
                self.transports[-1].supported = {"completion": ["unsupported"]}
            return client
        with self.assertRaisesRegex(deployment.DeploymentError, "does not advertise"):
            self.run_deploy(factory)
        self.assertTrue(all(call[0] == "GET" for http in self.transports for call in http.calls))
        self.assertEqual({}, self.cli.gates)

    def test_regional_failure_is_explicit_and_not_reported_as_global_success(self):
        def factory(endpoint, token, timeout):
            client = self.client_factory(endpoint, token, timeout)
            if endpoint == SECONDARY:
                self.transports[-1].poll_statuses = ["Failed"]
            return client
        with self.assertRaisesRegex(deployment.DeploymentError, "secondary provisioning failed"):
            self.run_deploy(factory)
        self.assertIn("primary: analyzer z-parent ready.", self.stdout.getvalue())
        self.assertNotIn("ready in both regions", self.stdout.getvalue())
        self.assertEqual({}, self.cli.gates)

    def test_gates_open_only_after_both_regional_analyzer_passes(self):
        original = self.cli.arm
        def arm(method, resource_id, suffix="", **kwargs):
            if method == "put" and suffix == "/namedValues/analyzers-ready":
                self.assertEqual(2, len(self.transports))
                for http in self.transports:
                    self.assertEqual(2, len([call for call in http.calls if call[0] == "PUT"]))
                    self.assertNotIn("/operations/", http.calls[-1][1])
            return original(method, resource_id, suffix, **kwargs)
        self.cli.arm = arm
        self.run_deploy()

    def test_gate_open_failure_rolls_back_gateway_and_fails_deployment(self):
        # Use the returned gateway resource ID, not guessed uniqueString defaults.
        ids = deployment.deployed_apim_ids(self.cli.outputs)
        self.cli.fail_gate = (ids[0], "true")
        with self.assertRaisesRegex(deployment.DeploymentError, "gate was closed again"):
            self.run_deploy()
        self.assertEqual({ids[0]: "false"}, self.cli.gates)
        self.assertNotIn("ready in both regions", self.stdout.getvalue())

    def test_invalid_gateway_secret_prevents_infrastructure_deployment(self):
        self.cli.existing()
        self.cli.stored[(APIM_IDS[0], "/subscriptions/" + deployment.SUBSCRIPTION_NAME + "/listSecrets")][
            "primaryKey"] = ""
        with self.assertRaisesRegex(deployment.DeploymentError, "keys are invalid"):
            self.run_deploy()
        self.assertFalse(any(args[:3] == ("deployment", "group", "create") for args, _ in self.cli.calls))

    def test_nonempty_user_managed_secret_input_is_rejected_without_echo(self):
        self.cli.parameters["primaryPollingSigningKey"] = {"value": "not-allowed-secret"}
        with self.assertRaises(deployment.DeploymentError) as error:
            self.run_deploy()
        self.assertNotIn("not-allowed-secret", str(error.exception))
        self.assertEqual(2, len(self.cli.calls))

    def test_private_files_cleaned_up_on_deployment_error(self):
        original = self.cli.run
        def failing(*args, **kwargs):
            result = original(*args, **kwargs)
            if args[:3] == ("deployment", "group", "validate"):
                raise deployment.DeploymentError("validation failed")
            return result
        self.cli.run = failing
        with self.assertRaisesRegex(deployment.DeploymentError, "validation failed"):
            self.run_deploy()
        self.assertTrue(self.cli.parameter_paths)
        self.assertTrue(all(not path.exists() for path in self.cli.parameter_paths))


class AzureCliTests(unittest.TestCase):
    def cli(self):
        with patch.object(deployment.shutil, "which", return_value="az"):
            return deployment.AzureCli("subscription-id")

    def test_secret_results_and_cli_errors_are_never_printed(self):
        cli = self.cli()
        with patch.object(deployment.subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 1, stdout="top-secret", stderr="ERROR: (Forbidden) credential top-secret"
        )):
            with self.assertRaises(deployment.AzureCommandError) as error:
                cli.run("rest", "--method", "post", "--url", "https://management.azure.com")
        self.assertNotIn("top-secret", str(error.exception))
        self.assertEqual("Forbidden", error.exception.code)

    def test_optional_cli_timeout_is_bounded_and_suppresses_private_output(self):
        cli = self.cli()
        cli.command_timeout = 45
        with patch.object(deployment.subprocess, "run", side_effect=subprocess.TimeoutExpired(
            "az", 45, output="private-token", stderr="private-token"
        )) as command:
            with self.assertRaisesRegex(deployment.DeploymentError, "outcome may be unknown") as error:
                cli.run("account", "get-access-token")
        self.assertEqual(45, command.call_args.kwargs["timeout"])
        self.assertNotIn("private-token", str(error.exception))

    def test_auth_token_is_captured_and_reused_never_passed_in_arguments(self):
        cli = self.cli()
        value = {"accessToken": "not-a-real-token", "expires_on": 99999999999}
        with patch.object(deployment.subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 0, stdout=json.dumps(value), stderr=""
        )) as command:
            self.assertEqual("not-a-real-token", cli.token())
            self.assertEqual("not-a-real-token", cli.token())
        self.assertEqual(1, command.call_count)
        arguments = command.call_args.args[0]
        self.assertNotIn("not-a-real-token", arguments)
        self.assertIn("--subscription", arguments)

    def test_principal_oid_read_from_cli_token(self):
        cli = self.cli()
        oid = "00000000-0000-0000-0000-000000000001"
        encoded = base64.urlsafe_b64encode(json.dumps({"oid": oid}).encode()).decode().rstrip("=")
        with patch.object(cli, "token", return_value="header." + encoded + ".signature"):
            self.assertEqual(oid, cli.principal_id())

    def test_arm_secret_endpoints_use_post_and_documented_version(self):
        cli = self.cli()
        with patch.object(cli, "run", return_value={"value": "not-real-secret"}) as command:
            cli.arm("post", APIM_IDS[0], "/namedValues/polling-signing-key/listValue")
        args = command.call_args.args
        self.assertEqual(("rest", "--method", "post", "--url"), args[:4])
        self.assertTrue(args[4].endswith("/namedValues/polling-signing-key/listValue?api-version=2024-05-01"))
        self.assertNotIn("not-real-secret", " ".join(args))

    def test_unexpected_arm_resource_id_rejected_before_authentication(self):
        cli = self.cli()
        with patch.object(cli, "run", side_effect=AssertionError("must not call Azure")):
            with self.assertRaises(deployment.DeploymentError):
                cli.arm("post", "https://attacker.example")

    def test_missing_deployment_only_ignored_for_specific_not_found_errors(self):
        cli = self.cli()
        for code, should_raise in (("DeploymentNotFound", False), ("AuthorizationFailed", True)):
            with self.subTest(code=code), patch.object(
                deployment.subprocess, "run",
                return_value=subprocess.CompletedProcess([], 1, "", f"ERROR: ({code}) hidden")
            ):
                if should_raise:
                    with self.assertRaises(deployment.AzureCommandError):
                        cli.run("deployment", "group", "show", missing_ok=True)
                else:
                    self.assertIsNone(cli.run("deployment", "group", "show", missing_ok=True))

    def test_private_workspace_cleanup_and_posix_permissions(self):
        with deployment.private_workspace(ROOT) as directory:
            self.assertEqual(ROOT, directory.parent)
            deployment.write_parameters(directory / "parameters.json", {"example": {"value": "fake"}})
            if os.name != "nt":
                self.assertEqual(0o700, directory.stat().st_mode & 0o777)
                self.assertEqual(0o600, (directory / "parameters.json").stat().st_mode & 0o777)
        self.assertFalse(directory.exists())


if __name__ == "__main__":
    unittest.main()
