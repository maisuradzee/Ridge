from pathlib import Path
import tempfile
import unittest

from Tools.BotLab.validate_ue_project import validate_project

ROOT = Path(__file__).resolve().parents[3]


class UEProjectIntegrationTests(unittest.TestCase):
    def test_ue58_project_and_bot_controller_are_wired(self):
        report = validate_project(ROOT)
        self.assertEqual(report["status"], "STATIC_PASS", report["checks_detail"])
        self.assertGreaterEqual(report["checks"], 17)
        self.assertEqual(report["ue_build_status"], "NOT_RUN_STATIC_ONLY")
        self.assertEqual(report["runtime_status"], "NOT_RUN_STATIC_ONLY")

    def test_login_subsystem_blueprint_and_transport_contract_is_in_static_validator(self):
        report = validate_project(ROOT)
        checks = {item["id"]: item for item in report["checks_detail"]}
        expected = [
            "session_login_header_exists",
            "session_login_uht_generated_include_last",
            "session_login_blueprint_entrypoint",
            "session_login_blueprint_result",
            "session_login_cpp_exists",
            "session_login_oidc_gateway_request",
            "session_login_bearer_authorization",
            "session_login_client_travel",
            "session_login_ticket_and_attempt_validation",
            "session_login_expiry_validation",
            "session_login_loopback_http_allowlist",
            "session_login_no_internal_service_secrets",
            "session_login_gateway_config",
            "transport_platform_crypto_plugin_enabled",
            "transport_aes_gcm_handler_plugin_enabled",
        ]
        for check_id in expected:
            self.assertIn(check_id, checks)
            self.assertEqual(checks[check_id]["status"], "PASS", checks[check_id])

    def test_ue58_build_script_builds_game_editor_and_optional_server(self):
        script = (ROOT / "Tools/BotLab/Run-UE58BotLabBuild.ps1").read_text(encoding="utf-8")
        self.assertIn("Name = 'RIDGE'; Purpose = 'Main game executable", script)
        self.assertIn("Name = 'RIDGEEditor'; Purpose = 'Editor and PIE", script)
        self.assertIn("Name = 'RIDGEServer'; Purpose = 'Dedicated Server", script)
        self.assertIn("ridge.ue58.build-report.v1", script)
        self.assertIn("Build.version", script)

    def test_ue58_windows_build_workflow_is_manual_and_isolated(self):
        workflow = (ROOT / ".github/workflows/ridge-ue58-windows-build.yml").read_text(encoding="utf-8")
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("runs-on: [self-hosted, Windows, X64, ridge-ue58]", workflow)
        self.assertIn("RIDGE_UE_ROOT", workflow)
        self.assertIn("Run-UE58BotLabBuild.ps1", workflow)
        self.assertIn("BuildDedicatedServer", workflow)
        self.assertIn("upload-artifact@v4", workflow)
        self.assertNotIn("pull_request:", workflow)

    def test_linux_preflight_uploads_static_ue_validation_report(self):
        workflow = (ROOT / ".github/workflows/ridge-stage5-preflight.yml").read_text(encoding="utf-8")
        self.assertIn("ridge-ue-project-static-validation", workflow)
        self.assertIn("ridge_ue_project_static_validation.json", workflow)
        self.assertIn("upload-artifact@v4", workflow)

    def test_missing_project_descriptor_is_a_failure_not_a_false_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            report = validate_project(Path(directory))
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["ue_build_status"], "NOT_RUN_STATIC_ONLY")


if __name__ == "__main__":
    unittest.main()