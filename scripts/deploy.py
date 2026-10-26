"""Incremental infrastructure deployment and two-region CU analyzer provisioning.

Requires Python 3.10+, Azure CLI (signed in), Bicep, infrastructure permissions,
and Cognitive Services User on each Foundry resource for the deployment identity.
No Azure Python packages, resource key authentication, copy/delete operations,
or runtime synchronization are used.

Analyzer IDs are JSON filenames without .json. Bodies use the GA create/replace
schema. Only exact models.completion="${completionModel}" and
models.embedding="${embeddingModel}" placeholders are substituted.

The deployment is not atomic across regions. Rerun after a partial failure;
removing a file never deletes an analyzer. Drain existing work before changing
definitions: this is not a zero-downtime, versioned rollout. Do not enable
production traffic on an initial stack until this command succeeds.
Every ARM deployment closes the nonsecret analyzers-ready gate. The script opens
the gateway gate only after both regional provisioning passes, with compensating
close operations on failure. CU provisioning is not atomic across regions.

Signing and serving keys are generated on initial provisioning, then preserved
from APIM. No automatic rotation: a mismatch fails before deployment. Deliberate
rotation requires a separately coordinated maintenance window and draining
outstanding signed polling URLs; do not remove named values to rotate keys.
Legacy deployment "main" is inspected for existing APIM names and synchronization
Function Apps. Stop/disable those apps explicitly before migration; this command
does not stop, delete, or coexist with an active runtime synchronization service.

Contracts:
https://learn.microsoft.com/rest/api/contentunderstanding/content-analyzers/create-or-replace?view=rest-contentunderstanding-2025-11-01
https://learn.microsoft.com/rest/api/contentunderstanding/content-analyzers/get-operation-status?view=rest-contentunderstanding-2025-11-01
https://learn.microsoft.com/azure/ai-services/content-understanding/concepts/models-deployments
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from fnmatch import fnmatchcase
from typing import Any, Callable, Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


ROOT = Path(__file__).resolve().parent.parent
API_VERSION = "2025-11-01"
ARM_VERSION = "2024-05-01"
DEPLOYMENT_NAME = "cu-regional-ha"
ROLE_ID = "a97b65f3-24c7-4388-baec-2e87135dc908"
ROLE_NAME = "Cognitive Services User"
SUBSCRIPTION_NAME = "foundry-content-understanding-sub"
SECURE_PARAMETERS = (
    "primaryPollingSigningKey",
    "servingSubscriptionPrimaryKey", "servingSubscriptionSecondaryKey",
)
# Public, fixed sentinels satisfy APIM's nonempty-value checks in validate/what-if.
# They are never deployed and are not generated/retrieved credentials.
VALIDATION_VALUES = {
    name: f"VALIDATION-ONLY-NOT-A-LIVE-CREDENTIAL-{index}-" + "0" * 32
    for index, name in enumerate(SECURE_PARAMETERS)
}
ANALYZER_ID = re.compile(r"[a-zA-Z0-9._-]{1,64}\Z")
COMPLETION_MODELS = {
    "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.2", "gpt-5.1",
    "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini",
    "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini",
}
EMBEDDING_MODELS = {
    "text-embedding-3-large", "text-embedding-3-small", "text-embedding-ada-002",
}


class DeploymentError(Exception):
    """A safe diagnostic that never includes a service response or credentials."""


class AzureCommandError(DeploymentError):
    def __init__(self, command: str, code: str = "AzureCommandFailed"):
        self.code = code
        super().__init__(f"{command} failed ({code}); Azure response suppressed to protect credentials.")


def strict_json(text: str) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict:
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON property.")
            result[key] = value
        return result

    def invalid_constant(_: str) -> None:
        raise ValueError("Non-finite JSON number.")

    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_constant)


class AzureCli:
    def __init__(self, subscription: str | None = None, *, command_timeout: float | None = None):
        self.executable = shutil.which("az")
        if not self.executable:
            raise DeploymentError("Azure CLI is required. Install it and sign in with az login.")
        self.subscription = subscription
        self.command_timeout = command_timeout
        self._token: str | None = None
        self._token_expiry = 0.0

    def run(self, *arguments: str, local: bool = False, missing_ok: bool = False) -> Any:
        command = [self.executable, *arguments, "--only-show-errors", "--output", "json"]
        if self.subscription and not local:
            command += ["--subscription", self.subscription]
        try:
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", check=False,
                                    timeout=self.command_timeout)
        except subprocess.TimeoutExpired:
            raise DeploymentError("Azure CLI timed out; the command outcome may be unknown.") from None
        except OSError:
            raise DeploymentError("Could not execute Azure CLI.") from None
        if result.returncode:
            # Never relay stderr: CLI errors can include parameter values or bodies.
            code = "AzureCommandFailed"
            for candidate in ("DeploymentNotFound", "ResourceNotFound", "AuthorizationFailed",
                              "Forbidden", "InvalidAuthenticationToken", "NotFound"):
                if re.search(rf"\b{candidate}\b", result.stderr):
                    code = candidate
                    break
            if missing_ok and code in {"DeploymentNotFound", "ResourceNotFound", "NotFound"}:
                return None
            raise AzureCommandError("az " + " ".join(arguments[:2]), code)
        if not result.stdout.strip():
            return None
        try:
            return strict_json(result.stdout)
        except (ValueError, TypeError):
            raise DeploymentError("Azure CLI returned invalid JSON (response suppressed).") from None

    def arm(self, method: str, resource_id: str, suffix: str = "", *, missing_ok: bool = False,
            body: dict | None = None) -> Any:
        if not re.fullmatch(
            r"/subscriptions/[A-Za-z0-9-]+/resourceGroups/[^/?#]+/providers/"
            r"Microsoft\.ApiManagement/service/[A-Za-z0-9-]+", resource_id,
            flags=re.IGNORECASE,
        ):
            raise DeploymentError("Invalid APIM resource ID.")
        url = f"https://management.azure.com{resource_id}{suffix}?api-version={ARM_VERSION}"
        if body is not None:
            with private_workspace(ROOT) as workspace:
                path = workspace / "request.json"
                path.write_text(json.dumps(body), encoding="utf-8")
                return self.run("rest", "--method", method, "--url", url, "--body", "@" + str(path),
                                "--headers", "If-Match=*", missing_ok=missing_ok)
        return self.run("rest", "--method", method, "--url", url, missing_ok=missing_ok)

    def token(self) -> str:
        if not self._token or time.time() + 60 >= self._token_expiry:
            result = self.run("account", "get-access-token",
                              "--resource", "https://cognitiveservices.azure.com/")
            if not isinstance(result, dict) or not result.get("accessToken"):
                raise DeploymentError("Azure CLI did not return a Cognitive Services access token.")
            self._token = result["accessToken"]
            self._token_expiry = float(result.get("expires_on", time.time() + 300))
        return self._token

    def principal_id(self) -> str:
        # This reads the CLI-issued token's identity claim, not an authentication
        # decision. The CU service still validates the token and enforces RBAC.
        try:
            payload = self.token().split(".")[1]
            claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
            oid = claims["oid"]
            if not re.fullmatch(r"[a-fA-F0-9-]{36}", oid):
                raise ValueError
            return oid
        except (ValueError, KeyError, IndexError, TypeError):
            raise DeploymentError("Cannot identify the deployment principal from its access token.") from None


def parameter_value(parameters: dict, template: dict, name: str) -> Any:
    if name in parameters:
        value = parameters[name].get("value")
    else:
        value = template.get("parameters", {}).get(name, {}).get("defaultValue")
    if value is None or (isinstance(value, str) and value.startswith("[")):
        raise DeploymentError(f"Parameter {name} must have an explicit value or a literal template default.")
    return value


@dataclass(frozen=True)
class ModelConfig:
    completion: str
    completion_deployment: str
    embedding: str
    embedding_deployment: str

    @classmethod
    def from_parameters(cls, parameters: dict, template: dict) -> ModelConfig:
        values = [parameter_value(parameters, template, name) for name in
                  ("modelName", "modelDeploymentName", "embeddingModelName", "embeddingDeploymentName")]
        if any(not isinstance(value, str) or not value or len(value) > 128 for value in values):
            raise DeploymentError("Model names and deployment names must be nonempty strings.")
        result = cls(*values)
        if result.completion not in COMPLETION_MODELS or result.embedding not in EMBEDDING_MODELS:
            raise DeploymentError("Configured model is not in the documented CU supported model set.")
        return result

    def deployments(self) -> dict[str, str]:
        # GA defaults map model names/aliases to deployment names, NOT ARM
        # connection IDs or role names. The root creates the local connection.
        return {
            self.completion: self.completion_deployment,
            self.embedding: self.embedding_deployment,
            "prebuilt-analyzer-completion": self.completion_deployment,
            "prebuilt-analyzer-completion-mini": self.completion_deployment,
            "prebuilt-analyzer-embedding": self.embedding_deployment,
        }

    def model_for(self, role: str, value: str) -> str:
        aliases = {
            "completion": {self.completion, "prebuilt-analyzer-completion",
                           "prebuilt-analyzer-completion-mini"},
            "embedding": {self.embedding, "prebuilt-analyzer-embedding"},
        }
        if role not in aliases or value not in aliases[role]:
            raise DeploymentError("Analyzer model reference has no matching configured deployment.")
        return self.completion if role == "completion" else self.embedding


@dataclass(frozen=True)
class Analyzer:
    id: str
    body: dict


def valid_id(value: Any) -> bool:
    return isinstance(value, str) and bool(ANALYZER_ID.fullmatch(value)) and value not in {".", ".."}


def validate_field(field: Any, definitions: dict, active: frozenset[str] = frozenset(),
                   depth: int = 0) -> None:
    if depth > 32:
        raise DeploymentError("Field schema exceeds the supported nesting depth.")
    if not isinstance(field, dict):
        raise DeploymentError("Field definitions must be JSON objects.")
    allowed = {"type", "$ref", "description", "enum", "enumDescriptions", "estimateSourceAndConfidence",
               "examples", "items", "method", "properties"}
    if set(field) - allowed:
        raise DeploymentError("Unknown field-schema property.")
    if "$ref" in field:
        ref = field["$ref"]
        if not isinstance(ref, str) or not ref.startswith("#/definitions/"):
            raise DeploymentError("Only local #/definitions/ field references are supported.")
        name = ref[len("#/definitions/"):]
        if name not in definitions or name in active:
            raise DeploymentError("Missing or cyclic field-schema reference.")
        validate_field(definitions[name], definitions, active | {name}, depth + 1)
        return
    kind = field.get("type")
    if not isinstance(kind, str) or kind not in {
        "string", "date", "time", "number", "integer", "boolean", "array", "object", "json"
    }:
        raise DeploymentError("Missing or unsupported field type.")
    if "method" in field and (
        not isinstance(field["method"], str) or field["method"] not in {"generate", "extract", "classify"}
    ):
        raise DeploymentError("Invalid field generation method.")
    if "description" in field and not isinstance(field["description"], str):
        raise DeploymentError("Field descriptions must be strings.")
    if "estimateSourceAndConfidence" in field and not isinstance(field["estimateSourceAndConfidence"], bool):
        raise DeploymentError("estimateSourceAndConfidence must be boolean.")
    for key in ("enum", "examples"):
        if key in field and (not isinstance(field[key], list)
                             or any(not isinstance(item, str) for item in field[key])):
            raise DeploymentError(f"Field {key} must be an array of strings.")
    if "enumDescriptions" in field and (
        not isinstance(field["enumDescriptions"], dict)
        or any(not isinstance(value, str) for value in field["enumDescriptions"].values())
    ):
        raise DeploymentError("enumDescriptions must be a string map.")
    if kind == "array":
        validate_field(field.get("items"), definitions, active, depth + 1)
    elif "items" in field:
        raise DeploymentError("Only array fields may have items.")
    if kind == "object":
        properties = field.get("properties")
        if not isinstance(properties, dict) or not properties:
            raise DeploymentError("Object fields require nonempty properties.")
        for name, value in properties.items():
            validate_field_name(name)
            validate_field(value, definitions, active, depth + 1)
    elif "properties" in field:
        raise DeploymentError("Only object fields may have properties.")


def validate_field_name(name: Any) -> None:
    if not isinstance(name, str) or not 1 <= len(name) <= 64 or any(
        not (char.isalnum() or char in "._-") for char in name
    ):
        raise DeploymentError("Invalid field name.")


def load_analyzers(directory: Path, models: ModelConfig) -> list[Analyzer]:
    if not directory.is_dir() or directory.is_symlink():
        raise DeploymentError("Analyzer directory must be an existing local directory.")
    files = sorted(directory.rglob("*.json"))
    if not files:
        raise DeploymentError("At least one analyzer JSON file is required.")
    by_id: dict[str, Analyzer] = {}
    canonical: dict[str, str] = {}
    for path in files:
        analyzer_id = path.stem
        if path.parent != directory or path.is_symlink() or not path.is_file():
            raise DeploymentError("Analyzer JSON files must be regular files directly in the analyzer directory.")
        if not valid_id(analyzer_id) or analyzer_id.lower().startswith("prebuilt-"):
            raise DeploymentError("Invalid or reserved analyzer filename/ID.")
        if analyzer_id.casefold() in canonical:
            raise DeploymentError("Duplicate analyzer IDs (case insensitive).")
        if path.stat().st_size > 1024 * 1024:
            raise DeploymentError("Analyzer JSON exceeds the 1 MiB local definition limit.")
        try:
            body = strict_json(path.read_text(encoding="utf-8-sig"))
        except (ValueError, UnicodeError, OSError, RecursionError):
            raise DeploymentError(f"Invalid JSON in analyzer file {path.name}.") from None
        if not isinstance(body, dict):
            raise DeploymentError("Analyzer definition must be a JSON object.")
        if "analyzerId" in body and body.pop("analyzerId") != analyzer_id:
            raise DeploymentError("analyzerId must match the JSON filename.")
        allowed = {"description", "baseAnalyzerId", "config", "dynamicFieldSchema", "fieldSchema",
                   "models", "processingLocation", "tags"}
        if set(body) - allowed:
            raise DeploymentError("Unsupported analyzer property; use a GA create/replace definition "
                                  "without server-owned properties or external knowledge sources.")
        if not valid_id(body.get("baseAnalyzerId")):
            raise DeploymentError("An explicit, valid baseAnalyzerId is required.")
        if "description" in body and (not isinstance(body["description"], str) or len(body["description"]) > 1024):
            raise DeploymentError("Analyzer description must be a string of at most 1024 characters.")
        if "dynamicFieldSchema" in body and not isinstance(body["dynamicFieldSchema"], bool):
            raise DeploymentError("dynamicFieldSchema must be boolean.")
        if "processingLocation" in body and (
            not isinstance(body["processingLocation"], str)
            or body["processingLocation"] not in {"global", "dataZone", "geography"}
        ):
            raise DeploymentError("Invalid processingLocation.")
        tags = body.get("tags", {})
        if not isinstance(tags, dict) or len(tags) > 10 or any(
            not re.fullmatch(r"[a-zA-Z0-9+.:=_/-]{1,64}", key)
            or not isinstance(value, str) or not re.fullmatch(r"[a-zA-Z0-9+.:=_/-]{0,256}", value)
            for key, value in tags.items()
        ):
            raise DeploymentError("Invalid analyzer tags.")
        config = body.get("config", {})
        boolean_options = {"disableFaceBlurring", "enableFigureAnalysis", "enableFigureDescription",
                           "enableFormula", "enableLayout", "enableOcr", "enableSegment",
                           "estimateFieldSourceAndConfidence", "omitContent", "returnDetails", "segmentPerPage"}
        enum_options = {"annotationFormat": {"none", "markdown"},
                        "chartFormat": {"chartJs", "markdown"}, "tableFormat": {"html", "markdown"}}
        if not isinstance(config, dict) or set(config) - boolean_options - enum_options.keys() - {"locales"}:
            raise DeploymentError("Unsupported analyzer config. Inline/category analyzers are not supported.")
        if any(not isinstance(config[key], bool) for key in config.keys() & boolean_options):
            raise DeploymentError("Analyzer config flags must be booleans.")
        if any(not isinstance(config[key], str) or config[key] not in choices
               for key, choices in enum_options.items() if key in config):
            raise DeploymentError("Invalid analyzer config format.")
        if "locales" in config and (not isinstance(config["locales"], list)
                                    or any(not isinstance(item, str) for item in config["locales"])):
            raise DeploymentError("locales must be an array of strings.")
        schema = body.get("fieldSchema")
        if (not isinstance(schema, dict) or set(schema) - {"name", "description", "fields", "definitions"}
                or not isinstance(schema.get("name"), str) or not schema["name"]
                or not isinstance(schema.get("fields"), dict) or not schema["fields"]):
            raise DeploymentError("A named fieldSchema with nonempty fields is required.")
        definitions = schema.get("definitions", {})
        if not isinstance(definitions, dict):
            raise DeploymentError("fieldSchema.definitions must be an object.")
        if "description" in schema and not isinstance(schema["description"], str):
            raise DeploymentError("fieldSchema.description must be a string.")
        for fields in (definitions, schema["fields"]):
            for name, field in fields.items():
                validate_field_name(name)
                validate_field(field, definitions)
        references = body.get("models")
        if not isinstance(references, dict) or "completion" not in references:
            raise DeploymentError("Analyzer models must explicitly declare a completion model.")
        for role, model in references.items():
            if role not in {"completion", "embedding"} or not isinstance(model, str):
                raise DeploymentError("Invalid analyzer model role or model name.")
            placeholder = "${completionModel}" if role == "completion" else "${embeddingModel}"
            if model == placeholder:
                references[role] = models.completion if role == "completion" else models.embedding
            models.model_for(role, references[role])
        if "${" in json.dumps(body):
            raise DeploymentError("Unresolved template expression; only exact declared model placeholders are supported.")
        by_id[analyzer_id] = Analyzer(analyzer_id, body)
        canonical[analyzer_id.casefold()] = analyzer_id

    ordered: list[Analyzer] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(analyzer_id: str) -> None:
        if analyzer_id in visiting:
            raise DeploymentError("Cyclic baseAnalyzerId dependencies.")
        if analyzer_id in visited:
            return
        visiting.add(analyzer_id)
        base = by_id[analyzer_id].body["baseAnalyzerId"]
        if not base.startswith("prebuilt-"):
            if base not in by_id:
                raise DeploymentError("Missing custom baseAnalyzerId; include its JSON definition.")
            visit(base)
        visiting.remove(analyzer_id)
        visited.add(analyzer_id)
        ordered.append(by_id[analyzer_id])

    for analyzer_id in by_id:
        visit(analyzer_id)
    return ordered


@contextmanager
def private_workspace(root: Path) -> Iterator[Path]:
    # Never use the system temp directory. Restrict Windows ACLs BEFORE writing
    # credentials; chmod alone does not restrict Windows file access.
    with tempfile.TemporaryDirectory(prefix=".cu-deploy-", dir=root) as name:
        directory = Path(name)
        try:
            if os.name == "nt":
                identity = subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                     "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
                    capture_output=True, text=True, check=True,
                ).stdout.strip()
                if not re.fullmatch(r"S-\d+(?:-\d+)+", identity):
                    raise ValueError
                subprocess.run(["icacls", str(directory), "/inheritance:r", "/grant:r",
                                f"*{identity}:(OI)(CI)F"], capture_output=True, check=True)
            else:
                directory.chmod(0o700)
        except (OSError, ValueError, subprocess.CalledProcessError):
            raise DeploymentError("Could not restrict private deployment parameter directory permissions.") from None
        yield directory


def write_parameters(path: Path, parameters: dict) -> None:
    document = {"$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#",
                "contentVersion": "1.0.0.0", "parameters": parameters}
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(document, stream)


def output_value(outputs: dict, name: str) -> str:
    item = outputs.get(name, {})
    value = item.get("value") if isinstance(item, dict) else None
    if not isinstance(value, str) or not value:
        raise DeploymentError(f"Deployment output {name} is required.")
    return value


def require_role_assignment_permission(cli: AzureCli, group: str) -> None:
    resource_group = cli.run("group", "show", "--name", group)
    scope = resource_group.get("id") if isinstance(resource_group, dict) else None
    if not isinstance(scope, str) or not re.fullmatch(
        r"/subscriptions/[a-fA-F0-9-]{36}/resourceGroups/[^/?#]+", scope, re.IGNORECASE,
    ):
        raise DeploymentError("Cannot identify the target resource group for the IAM permission check.")
    prefix = f"https://management.azure.com{scope}/providers/Microsoft.Authorization/permissions?"
    url = prefix + "api-version=2022-04-01"
    action = "microsoft.authorization/roleassignments/write"
    visited = set()
    while url:
        if not isinstance(url, str) or not url.startswith(prefix) or url in visited:
            raise DeploymentError("Azure returned invalid IAM permission pagination.")
        visited.add(url)
        document = cli.run("rest", "--method", "get", "--url", url)
        permissions = document.get("value") if isinstance(document, dict) else None
        if not isinstance(permissions, list):
            raise DeploymentError("Azure returned an invalid IAM permission response.")
        for permission in permissions:
            if not isinstance(permission, dict):
                raise DeploymentError("Azure returned an invalid IAM permission entry.")
            allowed = permission.get("actions")
            excluded = permission.get("notActions", [])
            if any(not isinstance(items, list) or any(not isinstance(item, str) for item in items)
                   for items in (allowed, excluded)):
                raise DeploymentError("Azure returned invalid IAM action patterns.")
            if (any(fnmatchcase(action, pattern.lower()) for pattern in allowed)
                    and not any(fnmatchcase(action, pattern.lower()) for pattern in excluded)):
                return
        url = document.get("nextLink")
    raise DeploymentError(
        "Deployment identity lacks Microsoft.Authorization/roleAssignments/write at the target resource group. "
        "An administrator must grant suitable group-scoped IAM rights, such as Role Based Access Control "
        "Administrator, before deployment. No credentials or billable resources were created by this command."
    )


def deployment_outputs(cli: AzureCli, group: str, name: str) -> dict:
    previous = cli.run("deployment", "group", "show", "--resource-group", group,
                       "--name", name, missing_ok=True)
    outputs = previous.get("properties", {}).get("outputs", {}) if previous else {}
    if outputs is None and previous.get("properties", {}).get("provisioningState") in {"Failed", "Canceled"}:
        print(f"Previous deployment {name} ended without outputs; recovery requires explicit existing "
              "APIM names and live credential verification.", file=sys.stderr)
        return {}
    if not isinstance(outputs, dict):
        raise DeploymentError("Existing deployment outputs are invalid; refusing to infer resource names.")
    return outputs


def verify_legacy_sync_stopped(cli: AzureCli, group: str, outputs: dict) -> None:
    for region in ("primary", "secondary"):
        item = outputs.get(region + "ReplicationFunctionAppName", {})
        name = item.get("value") if isinstance(item, dict) else None
        if not name:
            continue
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,60}", name):
            raise DeploymentError("Cannot identify legacy analyzer synchronization Function Apps safely.")
        try:
            app = cli.run("functionapp", "show", "--resource-group", group, "--name", name, missing_ok=True)
        except DeploymentError:
            raise DeploymentError("Cannot verify that legacy analyzer synchronization is stopped. "
                                  "Check Function App access and explicitly stop/disable legacy apps before retrying.") from None
        if app is None:
            continue
        if not isinstance(app, dict) or (
            str(app.get("state", "")).lower() != "stopped" and app.get("enabled") is not False
        ):
            raise DeploymentError(f"Legacy analyzer synchronization Function App {name} is not confirmed stopped "
                                  "or disabled. Explicitly stop/disable both legacy apps before provisioning; "
                                  "incremental deployment does not remove them and this script will not stop/delete them.")


def preserve_foundry_names(outputs: dict, parameters: dict, group: str, scope: str | None = None) -> None:
    for region in ("primary", "secondary"):
        output = region + "FoundryResourceId"
        if output not in outputs:
            continue
        identity = re.fullmatch(
            r"(?P<scope>/subscriptions/[A-Za-z0-9-]+/resourceGroups/(?P<group>[^/?#]+))"
            r"/providers/Microsoft\.CognitiveServices/accounts/(?P<name>[A-Za-z0-9-]{2,64})",
            output_value(outputs, output), re.IGNORECASE,
        )
        if (not identity or identity.group("group").casefold() != group.casefold()
                or (scope and identity.group("scope").casefold() != scope.casefold())):
            raise DeploymentError("Invalid existing Foundry resource identity; refusing resource replacement.")
        name = identity.group("name")
        parameter = region + "FoundryName"
        if parameter in parameters:
            item = parameters[parameter]
            requested = item.get("value") if isinstance(item, dict) else None
            if not isinstance(requested, str) or requested.casefold() != name.casefold():
                raise DeploymentError(f"{parameter} differs from the existing deployment; "
                                      "refusing resource replacement. Use a new resource group for a new stack.")
        parameters[parameter] = {"value": name}


def resolve_apims(cli: AzureCli, group: str, parameters: dict) -> list[tuple[str, str | None]]:
    current = deployment_outputs(cli, group, DEPLOYMENT_NAME)
    legacy = deployment_outputs(cli, group, "main")
    verify_legacy_sync_stopped(cli, group, legacy)
    verify_legacy_sync_stopped(cli, group, current)
    outputs = {**legacy, **current}
    resources = cli.run("resource", "list", "--resource-group", group,
                        "--resource-type", "Microsoft.ApiManagement/service")
    if not isinstance(resources, list):
        raise DeploymentError("Cannot inventory existing APIM resources; refusing to generate credentials.")
    existing = {}
    for item in resources:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise DeploymentError("Invalid APIM resource inventory; refusing to generate credentials.")
        identity = apim_identity(item.get("id"))
        name = item["name"]
        if (name.casefold() != identity.group("name").casefold()
                or group.casefold() != identity.group("group").casefold()
                or name.casefold() in existing):
            raise DeploymentError("Invalid APIM resource inventory; refusing to generate credentials.")
        existing[name.casefold()] = item["id"]
    old_id = output_value(outputs, "gatewayResourceId") if "gatewayResourceId" in outputs else None
    old_name = apim_identity(old_id).group("name") if old_id else None
    if not old_name:
        item = outputs.get("primaryApimName", {})
        old_name = item.get("value") if isinstance(item, dict) else None
    if not old_name:
        for output in ("contentUnderstandingUrl", "primaryContentUnderstandingUrl"):
            item = outputs.get(output, {})
            old_url = item.get("value") if isinstance(item, dict) else None
            if isinstance(old_url, str):
                try:
                    host = urlsplit(old_url).hostname or ""
                except ValueError:
                    raise DeploymentError("Invalid existing APIM gateway URL.") from None
                if host.endswith(".azure-api.net"):
                    old_name = host.removesuffix(".azure-api.net")
                    break
    item = parameters.get("primaryApimName", {})
    name = item.get("value") if isinstance(item, dict) else None
    if any(value and (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,50}", value))
           for value in (old_name, name)):
        raise DeploymentError("Invalid APIM name.")
    if name and old_name and name.casefold() != old_name.casefold():
        raise DeploymentError("APIM name differs from the existing deployment; refusing resource replacement.")
    if not name and old_name:
        name = old_name
        parameters["primaryApimName"] = {"value": name}
    if not name:
        if existing:
            raise DeploymentError("Existing APIM names cannot be resolved safely. Set the retained "
                                  "primaryApimName explicitly in your parameter file.")
        preserve_foundry_names(outputs, parameters, group)
        return [("primary", None)]
    resource_id = existing.get(name.casefold())
    if (old_name and not resource_id) or (old_id and old_id.casefold() != resource_id.casefold()):
        raise DeploymentError("Existing gateway does not match the APIM inventory; refusing credential replacement.")
    preserve_foundry_names(outputs, parameters, group, apim_identity(resource_id).group("scope") if resource_id else None)
    return [("primary", resource_id)]


def preserved_credentials(cli: AzureCli, apims: list[tuple[str, str | None]]) -> dict[str, str]:
    signing: dict[str, str | None] = {}
    serving: list[tuple[str, str]] = []
    for region, resource_id in apims:
        if not resource_id:
            signing[region] = None
            continue
        try:
            named_value = cli.arm("post", resource_id, "/namedValues/polling-signing-key/listValue",
                                  missing_ok=True)
            subscription = cli.arm("post", resource_id,
                                   f"/subscriptions/{SUBSCRIPTION_NAME}/listSecrets", missing_ok=True)
        except DeploymentError:
            raise DeploymentError(f"Cannot read existing {region} APIM credentials; refusing to generate or "
                                  "overwrite keys. Verify APIM named-value and subscription listSecrets permissions.") from None
        value = named_value.get("value") if isinstance(named_value, dict) else None
        if named_value is not None and (not isinstance(value, str) or len(value) < 32):
            raise DeploymentError("Existing APIM signing key is invalid; no credentials changed.")
        signing[region] = value
        if not isinstance(subscription, dict):
            raise DeploymentError(f"Existing {region} APIM serving subscription keys could not be read; "
                                  "refusing to generate replacement keys. Resolve the existing subscription explicitly.")
        pair = (subscription.get("primaryKey"), subscription.get("secondaryKey"))
        if any(not isinstance(key, str) or len(key) < 16 for key in pair):
            raise DeploymentError("Existing serving subscription keys are invalid; no credentials changed.")
        serving.append(pair)
    if serving and any(pair != serving[0] for pair in serving[1:]):
        raise DeploymentError("Regional serving subscription keys differ. Coordinate migration explicitly; "
                              "refusing to rotate or overwrite live credentials.")
    primary, secondary = serving[0] if serving else (secrets.token_hex(32), secrets.token_hex(32))
    return {
        "primaryPollingSigningKey": signing["primary"] or secrets.token_hex(32),
        "servingSubscriptionPrimaryKey": primary,
        "servingSubscriptionSecondaryKey": secondary,
    }


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        return None


@dataclass
class HttpResult:
    status: int
    headers: dict[str, str]
    body: dict


def safe_endpoint(endpoint: str) -> str:
    try:
        parts = urlsplit(endpoint)
        if (parts.scheme != "https" or not parts.hostname
                or not parts.hostname.endswith((".services.ai.azure.com", ".cognitiveservices.azure.com"))
                or parts.port not in {None, 443} or parts.username or parts.password
                or parts.path not in {"", "/"} or parts.query or parts.fragment
                or any(ord(char) <= 32 for char in endpoint) or "\\" in endpoint):
            raise ValueError
    except (ValueError, TypeError):
        raise DeploymentError("CU endpoint must be a regional Azure Foundry HTTPS resource origin.") from None
    return endpoint.rstrip("/")


def retry_delay(value: str | None, now: float | None = None) -> float:
    if not value:
        return 2.0
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = parsedate_to_datetime(value).timestamp() - (time.time() if now is None else now)
        except (ValueError, TypeError, OverflowError):
            return 2.0
    return max(1.0, seconds) if math.isfinite(seconds) else 2.0


class ContentUnderstanding:
    def __init__(self, endpoint: str, token: Callable[[], str], timeout: float = 300,
                 transport: Callable[..., HttpResult] | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.endpoint = safe_endpoint(endpoint)
        self.token = token
        self.timeout = timeout
        self.transport = transport or self._http
        self.clock = clock
        self.sleep = sleep
        self.opener = build_opener(NoRedirect())

    def _http(self, method: str, url: str, body: dict | None, timeout: float) -> HttpResult:
        request = Request(url, data=json.dumps(body).encode() if body is not None else None,
                          headers={"Authorization": "Bearer " + self.token(), "Accept": "application/json",
                                   "Content-Type": "application/json"}, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                data = response.read(4 * 1024 * 1024 + 1)
                if len(data) > 4 * 1024 * 1024:
                    raise DeploymentError("CU management response exceeded the local size limit.")
                try:
                    parsed = strict_json(data.decode("utf-8")) if data else {}
                except (ValueError, UnicodeError):
                    raise DeploymentError("CU returned invalid JSON.") from None
                if not isinstance(parsed, dict):
                    raise DeploymentError("CU management response must be an object.")
                return HttpResult(response.status, {key.lower(): value for key, value in response.headers.items()},
                                  parsed)
        except HTTPError as error:
            # Do not read/echo remote error bodies: they may contain document data.
            headers = {key.lower(): value for key, value in error.headers.items()}
            status = error.code
            error.close()
            return HttpResult(status, headers, {})
        except (URLError, OSError, TimeoutError):
            raise DeploymentError("CU management request failed (network/TLS/timeout); no request was replayed.") from None

    def request(self, method: str, path: str, body: dict | None = None) -> HttpResult:
        result = self.transport(method, self.endpoint + path + "?api-version=" + API_VERSION, body, 30)
        if result.status not in {200, 201, 202}:
            raise DeploymentError(f"CU management {method} failed with HTTP {result.status}; "
                                  "verify network access and the deployment identity's Cognitive Services User role.")
        return result

    def preflight(self, analyzers: list[Analyzer], models: ModelConfig) -> None:
        by_id = {analyzer.id: analyzer for analyzer in analyzers}
        prebuilt: dict[str, dict] = {}
        for analyzer in analyzers:
            base = analyzer.body["baseAnalyzerId"]
            while base in by_id:
                base = by_id[base].body["baseAnalyzerId"]
            if base not in prebuilt:
                result = self.request("GET", f"/contentunderstanding/analyzers/{base}").body
                if str(result.get("status", "")).lower() != "ready":
                    raise DeploymentError("Required prebuilt analyzer is not ready.")
                prebuilt[base] = result
            supported = prebuilt[base].get("supportedModels", {})
            if not isinstance(supported, dict):
                raise DeploymentError("Prebuilt analyzer supportedModels must be an object.")
            for role, value in analyzer.body["models"].items():
                available = supported.get(role)
                if not isinstance(available, list) or models.model_for(role, value) not in available:
                    raise DeploymentError("The regional prebuilt analyzer does not advertise support for "
                                          "the configured model. No analyzer definitions were written.")

    def configure_models(self, models: ModelConfig) -> None:
        mappings = models.deployments()
        self.request("PATCH", "/contentunderstanding/defaults", {"modelDeployments": mappings})
        actual = self.request("GET", "/contentunderstanding/defaults").body.get("modelDeployments", {})
        if not isinstance(actual, dict) or any(actual.get(key) != value for key, value in mappings.items()):
            raise DeploymentError("CU model deployment defaults did not match the requested mappings.")

    def operation_url(self, url: str, analyzer_id: str) -> str:
        try:
            parts = urlsplit(url)
            endpoint = urlsplit(self.endpoint)
            path = rf"/contentunderstanding/analyzers/{re.escape(analyzer_id)}/operations/([A-Za-z0-9._~-]{{1,256}})"
            match = re.fullmatch(path, parts.path)
            if (parts.scheme != "https" or parts.hostname != endpoint.hostname
                    or parts.port not in {None, 443} or parts.username or parts.password or parts.fragment
                    or not match or match.group(1) in {".", ".."}
                    or parse_qs(parts.query).get("api-version") != [API_VERSION]
                    or any(ord(char) <= 32 for char in url) or "\\" in url):
                raise ValueError
        except (ValueError, TypeError):
            raise DeploymentError("Rejected unsafe/nonlocal analyzer Operation-Location; no token was forwarded.") from None
        return url

    def provision(self, analyzer: Analyzer) -> None:
        path = f"/contentunderstanding/analyzers/{analyzer.id}"
        deadline = self.clock() + self.timeout
        response = self.transport("PUT", self.endpoint + path + f"?api-version={API_VERSION}&allowReplace=true",
                                  analyzer.body, min(30, self.timeout))
        if response.status not in {200, 201, 202}:
            raise DeploymentError(f"Analyzer {analyzer.id} create/replace failed with HTTP {response.status}.")
        operation = self.operation_url(response.headers.get("operation-location", ""), analyzer.id)
        while True:
            remaining = deadline - self.clock()
            wait = retry_delay(response.headers.get("retry-after"))
            if remaining <= wait:
                raise DeploymentError(f"Analyzer {analyzer.id} provisioning deadline exceeded; rerun safely to retry.")
            self.sleep(wait)
            remaining = deadline - self.clock()
            if remaining <= 0:
                raise DeploymentError(f"Analyzer {analyzer.id} provisioning deadline exceeded.")
            response = self.transport("GET", operation, None, min(30, remaining))
            if response.status in {429, 500, 502, 503, 504}:
                continue
            if response.status != 200:
                raise DeploymentError(f"Analyzer {analyzer.id} operation polling failed with HTTP {response.status}.")
            status = str(response.body.get("status", "")).lower()
            if status == "succeeded":
                break
            if status in {"failed", "canceled", "cancelled"}:
                raise DeploymentError(f"Analyzer {analyzer.id} provisioning reached terminal state {status}.")
            if status not in {"running", "notstarted"}:
                raise DeploymentError(f"Analyzer {analyzer.id} provisioning returned an unknown operation status.")
        remaining = deadline - self.clock()
        if remaining <= 0:
            raise DeploymentError(f"Analyzer {analyzer.id} readiness verification deadline exceeded.")
        verified = self.transport("GET", self.endpoint + path + "?api-version=" + API_VERSION,
                                  None, min(30, remaining))
        if (verified.status != 200 or verified.body.get("analyzerId") != analyzer.id
                or str(verified.body.get("status", "")).lower() != "ready"):
            raise DeploymentError(f"Analyzer {analyzer.id} was not ready after operation success.")


def verify_data_plane_role(cli: AzureCli, outputs: dict) -> None:
    principal = cli.principal_id()
    for region in ("primary", "secondary"):
        scope = output_value(outputs, region + "FoundryResourceId")
        arguments = ("role", "assignment", "list", "--assignee-object-id", principal,
                     "--scope", scope, "--include-inherited", "--fill-principal-name", "false",
                     "--fill-role-definition-name", "false")

        def has_role(assignments: Any) -> bool:
            return isinstance(assignments, list) and any(
                str(item.get("roleDefinitionId", "")).lower().endswith("/" + ROLE_ID)
                for item in assignments if isinstance(item, dict)
            )

        assignments = cli.run(*arguments)
        # Avoid unnecessary Microsoft Graph group-membership access for the
        # common direct/inherited assignment case (especially CI principals).
        if not has_role(assignments):
            assignments = cli.run(*arguments, "--include-groups")
        if not has_role(assignments):
            raise DeploymentError(f"Deployment identity needs {ROLE_NAME} ({ROLE_ID}) on {region} Foundry "
                                  "or an inherited scope. Assign it and rerun; no analyzer definitions were written.")


def deployed_apim_ids(outputs: dict) -> list[str]:
    resource_id = output_value(outputs, "gatewayResourceId")
    identity = apim_identity(resource_id)
    foundry_id = output_value(outputs, "primaryFoundryResourceId")
    prefix = re.fullmatch(
        r"(/subscriptions/[A-Za-z0-9-]+/resourceGroups/[^/?#]+)/providers/"
        r"Microsoft\.CognitiveServices/accounts/[^/?#]+", foundry_id, re.IGNORECASE,
    )
    if not prefix or identity.group("scope").casefold() != prefix.group(1).casefold():
        raise DeploymentError("Gateway and Foundry resource IDs must belong to the same deployment scope.")
    return [resource_id]


def apim_identity(resource_id: Any) -> re.Match:
    identity = re.fullmatch(
        r"(?P<scope>/subscriptions/[A-Za-z0-9-]+/resourceGroups/(?P<group>[^/?#]+))"
        r"/providers/Microsoft\.ApiManagement/service/(?P<name>[A-Za-z0-9-]{1,50})",
        resource_id if isinstance(resource_id, str) else "", re.IGNORECASE,
    )
    if not identity:
        raise DeploymentError("Invalid APIM resource identity; refusing unsafe credential or settings access.")
    return identity


def set_analyzer_gate(cli: AzureCli, resource_id: str, ready: bool, timeout: float,
                      clock: Callable[[], float] = time.monotonic,
                      sleep: Callable[[float], None] = time.sleep) -> None:
    suffix = "/namedValues/analyzers-ready"
    desired = "true" if ready else "false"
    deadline = clock() + timeout
    cli.arm("put", resource_id, suffix, body={
        "properties": {"displayName": "analyzers-ready", "secret": False, "value": desired},
    })
    while clock() < deadline:
        current = cli.arm("get", resource_id, suffix)
        properties = current.get("properties", {}) if isinstance(current, dict) else {}
        state = str(properties.get("provisioningState", "")).lower()
        if state in {"failed", "canceled", "cancelled"}:
            raise DeploymentError("APIM analyzer-readiness gate update failed.")
        if state in {"succeeded", ""}:
            # ARM GET can omit value, even for a nonsecret named value.
            actual = cli.arm("post", resource_id, suffix + "/listValue")
            if isinstance(actual, dict) and actual.get("value") == desired:
                return
        elif state not in {"inprogress", "creating", "updating", "accepted", "running"}:
            raise DeploymentError("APIM analyzer-readiness gate has an unknown provisioning state.")
        remaining = deadline - clock()
        if remaining <= 1:
            break
        sleep(min(2, remaining))
    raise DeploymentError("APIM analyzer-readiness gate update deadline exceeded.")


def enable_analyzer_gates(cli: AzureCli, resource_ids: list[str], timeout: float) -> None:
    try:
        for resource_id in resource_ids:
            set_analyzer_gate(cli, resource_id, True, timeout)
    except (DeploymentError, OSError, ValueError):
        failed_closes = []
        for index, resource_id in enumerate(resource_ids):
            try:
                set_analyzer_gate(cli, resource_id, False, timeout)
            except (DeploymentError, OSError, ValueError):
                failed_closes.append("primary" if index == 0 else "secondary")
        if failed_closes:
            raise DeploymentError("Opening analyzer-readiness gates failed, and rollback could not confirm "
                                  "closed gates for: " + ", ".join(failed_closes) + ". Keep production traffic "
                                  "disabled externally and set namedValues/analyzers-ready to false before retrying.") from None
        raise DeploymentError("Opening analyzer-readiness gates failed. The gate was closed again; "
                              "no deployment success is claimed. Correct the ARM failure and rerun.") from None


def deploy(args: argparse.Namespace, cli: AzureCli | None = None,
           client_factory: Callable[..., ContentUnderstanding] = ContentUnderstanding) -> None:
    cli = cli or AzureCli(args.subscription_id)
    parameter_file = Path(args.parameter_file).resolve()
    if not parameter_file.is_file():
        raise DeploymentError("Bicep parameter file does not exist.")
    template = cli.run("bicep", "build", "--file", str(ROOT / "main.bicep"), "--stdout", local=True)
    compiled = cli.run("bicep", "build-params", "--file", str(parameter_file), "--stdout", local=True)
    if isinstance(compiled, dict) and "parametersJson" in compiled:
        compiled = strict_json(compiled["parametersJson"])
    if not isinstance(template, dict) or not isinstance(compiled, dict) or not isinstance(compiled.get("parameters"), dict):
        raise DeploymentError("Bicep compilation did not return a template and parameter document.")
    parameters = copy.deepcopy(compiled["parameters"])
    locations = [parameter_value(parameters, template, region + "Location") for region in ("primary", "secondary")]
    if any(not isinstance(location, str) or not location.strip() for location in locations):
        raise DeploymentError("Both Azure regions must be explicit nonempty strings.")
    if locations[0].replace(" ", "").casefold() == locations[1].replace(" ", "").casefold():
        raise DeploymentError("primaryLocation and secondaryLocation must be different.")
    if parameter_value(parameters, template, "contentUnderstandingApiVersion") != API_VERSION:
        raise DeploymentError(f"Provisioning supports only the documented GA CU API {API_VERSION}.")
    for name in SECURE_PARAMETERS:
        declaration = template.get("parameters", {}).get(name, {})
        if declaration.get("type", "").lower() != "securestring":
            raise DeploymentError(f"Root template must declare secure parameter {name}.")
        if parameters.get(name, {}).get("value"):
            raise DeploymentError(f"{name} is managed by this script; leave it empty in the parameter file.")
        parameters[name] = {"value": VALIDATION_VALUES[name]}
    models = ModelConfig.from_parameters(parameters, template)
    analyzers = load_analyzers(Path(args.analyzers_dir).resolve(), models)
    roles = cli.run("role", "definition", "list", "--name", ROLE_NAME)
    if not isinstance(roles, list) or not any(item.get("name", "").lower() == ROLE_ID for item in roles):
        raise DeploymentError(f"Built-in {ROLE_NAME} must resolve to {ROLE_ID}.")
    require_role_assignment_permission(cli, args.resource_group)

    with private_workspace(ROOT) as workspace:
        template_file = workspace / "template.json"
        template_file.write_text(json.dumps(template), encoding="utf-8")
        if not args.validate_only:
            apims = resolve_apims(cli, args.resource_group, parameters)
            credentials = preserved_credentials(cli, apims)
            parameters.update({name: {"value": value} for name, value in credentials.items()})
            if apims[0][1]:
                routing = cli.arm("get", apims[0][1], "/namedValues/active-backend", missing_ok=True)
                if routing is not None:
                    value = cli.arm("post", apims[0][1], "/namedValues/active-backend/listValue")
                    active = value.get("value") if isinstance(value, dict) else None
                    if not isinstance(active, str) or active not in {"primary-cu", "secondary-cu"}:
                        raise DeploymentError("Existing active-backend is invalid; refusing to reset routing.")
                    parameters["activeBackend"] = {"value": active}
        parameter_json = workspace / "parameters.json"
        write_parameters(parameter_json, parameters)
        common = ("--resource-group", args.resource_group, "--name", DEPLOYMENT_NAME,
                  "--template-file", str(template_file), "--parameters", "@" + str(parameter_json))
        cli.run("deployment", "group", "validate", *common)
        cli.run("deployment", "group", "what-if", *common, "--no-pretty-print")
        if args.validate_only:
            print("Local definitions, Bicep, role definition, effective IAM permissions, ARM validation and what-if passed. "
                  "No credentials read/generated and no resources or analyzers changed.")
            return
        deployed = cli.run("deployment", "group", "create", *common, "--mode", "Incremental")
    outputs = deployed.get("properties", {}).get("outputs", {}) if isinstance(deployed, dict) else {}
    endpoints = [safe_endpoint(output_value(outputs, region + "AcuEndpoint")) for region in ("primary", "secondary")]
    if urlsplit(endpoints[0]).hostname == urlsplit(endpoints[1]).hostname:
        raise DeploymentError("Regional CU endpoints must be distinct.")
    apim_ids = deployed_apim_ids(outputs)
    for name, expected in (("deployedModelName", models.completion_deployment),
                           ("deployedEmbeddingModelName", models.embedding_deployment)):
        if output_value(outputs, name) != expected:
            raise DeploymentError("Deployed model outputs do not match the compiled model configuration.")
    verify_data_plane_role(cli, outputs)
    clients = [client_factory(endpoint, cli.token, timeout=args.operation_timeout_seconds) for endpoint in endpoints]
    for client in clients:
        client.preflight(analyzers, models)
    for client in clients:
        client.configure_models(models)
    for region, client in zip(("primary", "secondary"), clients):
        try:
            for analyzer in analyzers:
                client.provision(analyzer)
                print(f"{region}: analyzer {analyzer.id} ready.")
        except DeploymentError as error:
            raise DeploymentError(f"{region} provisioning failed: {error} "
                                  "Regional updates are not atomic; do not enable production traffic. "
                                  "Rerun after correcting the failure.") from None
    enable_analyzer_gates(cli, apim_ids, args.operation_timeout_seconds)
    print("Incremental infrastructure and all listed analyzers are ready in both regions. "
          "The single gateway provisioning gate is open. Unlisted analyzers and legacy resources were not deleted.")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    result.add_argument("-g", "--resource-group", required=True)
    result.add_argument("-s", "--subscription-id")
    result.add_argument("-p", "--parameter-file", default=str(ROOT / "main.bicepparam"))
    result.add_argument("--analyzers-dir", default=str(ROOT / "analyzers"))
    result.add_argument("--operation-timeout-seconds", type=int, default=300)
    result.add_argument("--validate-only", action="store_true",
                        help="Local checks + ARM validate/what-if only; no secret reads/generation or Azure writes.")
    return result


def main() -> int:
    arguments = parser().parse_args()
    if not 1 <= arguments.operation_timeout_seconds <= 3600:
        parser().error("--operation-timeout-seconds must be between 1 and 3600.")
    try:
        deploy(arguments)
        return 0
    except (DeploymentError, OSError, ValueError) as error:
        # Only DeploymentError text is known safe; OS/JSON errors can contain data.
        message = str(error) if isinstance(error, DeploymentError) else "Local deployment input or file operation failed."
        print("Deployment failed: " + message, file=sys.stderr)
        return 1


if __name__ == "__main__":
    if sys.version_info < (3, 10):
        sys.exit("Python 3.10 or later is required.")
    sys.exit(main())
