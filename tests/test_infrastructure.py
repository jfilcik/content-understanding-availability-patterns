from pathlib import Path
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]


class InfrastructureContractTests(unittest.TestCase):
    def test_fresh_foundry_names_are_short_region_coded_and_regions_are_customizable(self):
        main = (ROOT / "main.bicep").read_text(encoding="utf-8")
        example = (ROOT / "main.example.bicepparam").read_text(encoding="utf-8")
        self.assertIn("param primaryLocation string = 'swedencentral'", main)
        self.assertIn("param secondaryLocation string = 'westeurope'", main)
        for side in ("primary", "secondary"):
            self.assertIn(f"param {side}Location = ", example)
            self.assertIn(f"{side}Location == 'swedencentral' ? 'swc'", main)
            self.assertIn(f"{side}Location == 'westeurope' ? 'weu' : toLower({side}Location)", main)
            self.assertIn(f"'foundry-${{toLower({side}RegionCode)}}-${{take(uniqueString(", main)
            self.assertIn(f"{side}Location, '{side}'), 6)}}'", main)
            self.assertIn(f"param {side}RegionCode = ", example)
            self.assertIn(f"param {side}FoundryName = ", example)

    def test_policy_cache_usage_fits_section_limits(self):
        for path in (ROOT / "policies").glob("*.xml"):
            policy = ET.fromstring(path.read_text(encoding="utf-8"))
            for section in policy:
                for name in ("cache-lookup-value", "cache-store-value", "cors"):
                    self.assertLessEqual(len(section.findall(f".//{name}")), 1, (path, section.tag, name))
            if policy.tag == "policies":
                self.assertEqual(policy.find("inbound")[0].tag, "cors")
            else:
                self.assertEqual("fragment", policy.tag)

    def test_no_cross_region_pool_or_replication_module(self):
        main = (ROOT / "main.bicep").read_text(encoding="utf-8")
        gateway = (ROOT / "modules" / "apim-foundry-gateway.bicep").read_text(encoding="utf-8")
        self.assertNotIn("analyzer-replication-function", main)
        self.assertNotIn("ReplicationFunction", main)
        self.assertIn("secondaryAcuEndpoint", gateway)
        self.assertNotIn("type: 'Pool'", gateway)
        self.assertNotIn("circuitBreaker:", gateway)
        self.assertIn("principalId: gateway.outputs.principalId", main)
        self.assertIn("foundryName: region.foundryName", main)
        self.assertEqual(1, main.count("'modules/apim-foundry-gateway.bicep'"))
        self.assertNotIn("TrafficManager", main)
        self.assertNotIn("trafficManager", main)
        self.assertIn("name: 'primary-cu'", gateway)
        self.assertIn("name: 'secondary-cu'", gateway)
        self.assertIn("scope: routingState", gateway)

    def test_serving_routes_do_not_expose_analyzer_management(self):
        policy = ET.parse(ROOT / "policies" / "content-understanding.xml")
        self.assertEqual(len(policy.findall(".//set-backend-service")), 1)
        self.assertIn('context.Variables["requestBackend"]', policy.find(".//set-backend-service").attrib["backend-id"])
        self.assertEqual(len(policy.findall(".//forward-request")), 1)
        self.assertEqual(policy.findall(".//retry"), [])
        self.assertIn("OperationNotSupported", ET.tostring(policy.getroot(), encoding="unicode"))

    def test_switch_is_conditional_and_polling_has_no_shared_breaker_or_cache_gate(self):
        for name in ("content-understanding.xml",):
            doc = ET.parse(ROOT / "policies" / name)
            for operation in ("cache-store-value", "cache-lookup-value"):
                for node in doc.findall(f".//{operation}"):
                    self.fail("Routing must not use per-node cooldown caches.")
        fragment = ET.parse(ROOT / "policies" / "switch-backend.xml")
        requests = fragment.findall(".//send-request")
        self.assertEqual(["GET", "PATCH"], [request.findtext("set-method") for request in requests])
        self.assertEqual(['{{routing-state-url}}'] * 2, [request.findtext("set-url") for request in requests])
        self.assertEqual(1, len(fragment.findall('.//set-header[@name="If-Match"]')))
        self.assertIn('{"properties":{"value":"secondary-cu"}}', ET.tostring(fragment.getroot(), encoding="unicode"))

    def test_startup_readiness_is_gated_and_telemetry_masks_tokens(self):
        gateway = (ROOT / "modules" / "apim-foundry-gateway.bicep").read_text(encoding="utf-8")
        self.assertIn("'analyzers-ready': 'false'", gateway)
        self.assertIn("{ mode: 'Hide', value: 'gateway-token' }", gateway)
        self.assertIn("{ mode: 'Hide', value: 'subscription-key' }", gateway)
        self.assertNotIn("bytes: 8192", gateway)
        self.assertNotIn("routingStatusUrl", (ROOT / "main.bicep").read_text(encoding="utf-8"))
        self.assertNotIn("resource healthApi", gateway)
        self.assertFalse((ROOT / "policies" / "health.xml").exists())

    def test_policies_avoid_runtime_rejected_expression_members(self):
        for path in (ROOT / "policies").glob("*.xml"):
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("UriKind", text)
            self.assertNotIn("Regex.Escape(", text)
            self.assertNotRegex(text, r'context\.Variables\["[^"]+"\]\.ToString\(')
            for trace in ET.fromstring(text).findall(".//trace"):
                self.assertIn(trace.attrib["severity"], ("verbose", "information", "error"))


if __name__ == "__main__":
    unittest.main()
