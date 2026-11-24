from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = ROOT / "deploy" / "production" / "nginx-ridge.conf"


class ProductionIngressContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = CONFIG_PATH.read_text(encoding="utf-8")

    def test_plain_http_never_processes_api_requests(self):
        http_server = re.search(
            r"server\s*\{(?:(?!\nserver\s*\{).)*?listen 80 default_server;(?:(?!\nserver\s*\{).)*?\}",
            self.config,
            re.DOTALL,
        )
        self.assertIsNotNone(http_server)
        self.assertIn("return 444;", http_server.group(0))

    def test_tls_is_restricted_to_modern_protocols(self):
        self.assertIn("listen 443 ssl default_server;", self.config)
        self.assertIn("ssl_protocols TLSv1.2 TLSv1.3;", self.config)

    def test_all_route_groups_have_rate_limits(self):
        for zone in ("ridge_general", "ridge_gateway", "ridge_control", "ridge_internal"):
            self.assertRegex(self.config, rf"limit_req_zone .*zone={zone}:")
        for location in (
            "location = /v1/gateway/session",
            "location ^~ /v1/control/",
            "location ^~ /v1/internal/",
            "location /",
        ):
            block = self._location_block(location)
            self.assertIn("limit_req ", block)
            self.assertIn("proxy_pass http://ridge_api_backend;", block)

    def test_forwarded_headers_are_overwritten_by_edge(self):
        self.assertIn("proxy_set_header X-Forwarded-For $remote_addr;", self.config)
        self.assertIn("proxy_set_header X-Forwarded-Proto https;", self.config)
        self.assertNotIn("$proxy_add_x_forwarded_for", self.config)

    def test_readiness_is_not_public_and_control_plane_is_private(self):
        self.assertIn("location = /ready {\n        return 404;", self.config)
        control = self._location_block("location ^~ /v1/control/")
        for cidr in ("127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"):
            self.assertIn(f"allow {cidr};", control)
        self.assertIn("deny all;", control)

    def test_access_log_does_not_record_query_or_credentials(self):
        line = next(line for line in self.config.splitlines() if "log_format ridge_safe" in line)
        self.assertIn("$uri", line)
        for forbidden in ("$request_uri", "$args", "$http_authorization", '"$request"'):
            self.assertNotIn(forbidden, line)

    def test_backend_upstream_is_loopback_only(self):
        self.assertRegex(self.config, r"server\s+127\.0\.0\.1:8787;")
        self.assertNotRegex(self.config, r"server\s+(?:0\.0\.0\.0|[0-9]{1,3}(?:\.[0-9]{1,3}){3}):8787;")

    def _location_block(self, declaration):
        start = self.config.find(declaration)
        self.assertGreaterEqual(start, 0, f"Missing {declaration}")
        opening = self.config.find("{", start)
        depth = 0
        for index in range(opening, len(self.config)):
            if self.config[index] == "{":
                depth += 1
            elif self.config[index] == "}":
                depth -= 1
                if depth == 0:
                    return self.config[opening + 1:index]
        self.fail(f"Unclosed block: {declaration}")


if __name__ == "__main__":
    unittest.main()
