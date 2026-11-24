from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github/workflows/ridge-ue58-windows-build.yml"
BUILD_SCRIPT = ROOT / "Tools/BotLab/Run-UE58BotLabBuild.ps1"
CRYPTO_PROBE = ROOT / "Tools/BotLab/Inspect-UE58CryptoProvider.ps1"
PROJECT = ROOT / "RIDGE.uproject"

TARGET_RULES = {
    "RIDGE.Target.cs": ("RIDGETarget", "TargetType.Game"),
    "RIDGEEditor.Target.cs": ("RIDGEEditorTarget", "TargetType.Editor"),
    "RIDGEServer.Target.cs": ("RIDGEServerTarget", "TargetType.Server"),
}


class UE58BuildGateContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")
        cls.build_script = BUILD_SCRIPT.read_text(encoding="utf-8")
        cls.crypto_probe = CRYPTO_PROBE.read_text(encoding="utf-8")
        cls.project = json.loads(PROJECT.read_text(encoding="utf-8"))

    def test_project_and_target_rules_match_engine_58(self):
        self.assertEqual("5.8", self.project["EngineAssociation"])
        module_names = {module["Name"] for module in self.project["Modules"]}
        self.assertIn("RIDGE", module_names)
        plugins = {plugin["Name"]: plugin["Enabled"] for plugin in self.project.get("Plugins", [])}
        self.assertIs(plugins.get("PlatformCrypto"), True)
        self.assertIs(plugins.get("AESGCMHandlerComponent"), True)
        for filename, (class_name, target_type) in TARGET_RULES.items():
            path = ROOT / "Source" / filename
            self.assertTrue(path.is_file(), filename)
            source = path.read_text(encoding="utf-8")
            self.assertIn(f"public class {class_name}", source)
            self.assertIn(f"Type = {target_type};", source)
            self.assertIn('ExtraModuleNames.Add("RIDGE")', source)

    def test_build_script_builds_expected_targets_in_order(self):
        game = self.build_script.index("Name = 'RIDGE';")
        editor = self.build_script.index("Name = 'RIDGEEditor';")
        server = self.build_script.index("Name = 'RIDGEServer';")
        self.assertLess(game, editor)
        self.assertLess(editor, server)
        self.assertIn("if ($BuildDedicatedServer)", self.build_script)

    def test_build_script_invokes_ubt_with_project_and_safe_build_flags(self):
        for required in (
            "Engine\\Build\\BatchFiles\\Build.bat",
            '"-Project=$ProjectFile"',
            "'-WaitMutex'",
            "'-NoHotReloadFromIDE'",
            "$LASTEXITCODE",
        ):
            self.assertIn(required, self.build_script)

    def test_build_report_distinguishes_ubt_uht_result_from_static_validation(self):
        for required in (
            "ridge.ue58.build-report.v1",
            "OverallStatus = $OverallStatus",
            "UBTAndUHT = if ($OverallStatus -eq 'PASS')",
            "Target = $Target.Name",
            "ExitCode = $ExitCode",
            "Status = $Status",
            "Log = $LogPath",
        ):
            self.assertIn(required, self.build_script)

    def test_workflow_is_manual_only_on_restricted_windows_runner(self):
        self.assertIn("workflow_dispatch:", self.workflow)
        self.assertIn("runs-on: [self-hosted, Windows, X64, ridge-ue58]", self.workflow)
        self.assertNotIn("pull_request:", self.workflow)
        self.assertNotIn("\n  push:", self.workflow)
        self.assertIn("permissions:\n  contents: read", self.workflow)
        self.assertIn("persist-credentials: false", self.workflow)

    def test_workflow_preflights_crypto_plugins_in_engine_installation(self):
        for required in (
            r"Engine\Plugins\Experimental\PlatformCrypto\PlatformCrypto.uplugin",
            r"Engine\Plugins\Runtime\PacketHandlers\AESGCMHandlerComponent\AESGCMHandlerComponent.uplugin",
        ):
            self.assertIn(required, self.workflow)

    def test_workflow_checks_engine_version_and_machine_toolchain(self):
        for required in (
            "RIDGE_UE_ROOT",
            "Engine\\Build\\Build.version",
            "MajorVersion",
            "MinorVersion",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "BuildDedicatedServer",
        ):
            self.assertIn(required, self.workflow)

    def test_workflow_requires_every_requested_target_and_nonempty_log(self):
        for required in (
            "$expectedTargets = @('RIDGE','RIDGEEditor')",
            "$expectedTargets += 'RIDGEServer'",
            "$actualTargets",
            "$target.ExitCode -ne 0",
            "$target.Status -ne 'PASS'",
            "Test-Path -LiteralPath $logPath -PathType Leaf",
            "$logFile.Length -lt 1",
            "$report.UBTAndUHT -ne 'PASS'",
        ):
            self.assertIn(required, self.workflow)

    def test_workflow_uploads_build_report_and_target_logs_even_on_failure(self):
        self.assertIn("if: always()", self.workflow)
        self.assertIn("ridge_ue58_build_report.json", self.workflow)
        self.assertIn("ue58_build_logs/*.log", self.workflow)
        self.assertIn("ridge-ue58-windows-build", self.workflow)
        self.assertIn("upload-artifact@v4", self.workflow)


    def test_crypto_provider_probe_is_present_and_reports_a_versioned_json_contract(self):
        self.assertTrue(CRYPTO_PROBE.is_file())
        for required in (
            "ridge.ue58.crypto-provider-probe.v1",
            "Engine\\Build\\Build.version",
            "PlatformCryptoApi",
            "OpenSSLThirdParty",
            "ProviderAssessment",
            "ridge_ue58_crypto_provider_probe.json",
        ):
            self.assertIn(required, self.crypto_probe)

    def test_crypto_provider_probe_inspects_x25519_hkdf_and_engine_crypto_context(self):
        for required in (
            "opensslv.h",
            "evp.h",
            "kdf.h",
            "EVP_PKEY_X25519",
            "EVP_PKEY_HKDF",
            "EncryptionContextOpenSSL.h",
            "CreateEncryptor_AES_256_GCM",
            "CreateRandomBytes",
            "CalcSHA256",
        ):
            self.assertIn(required, self.crypto_probe)

    def test_crypto_probe_is_diagnostic_and_does_not_select_or_enable_transport(self):
        for required in (
            "does not compile or link a crypto probe",
            "No ECDH/HKDF provider is selected automatically",
            "no production transport gate is changed",
        ):
            self.assertIn(required, self.crypto_probe)
        self.assertNotIn("GAME_TRANSPORT_ENCRYPTION_RUNTIME_VERIFIED", self.crypto_probe)

    def test_workflow_runs_crypto_probe_before_ubt_build(self):
        probe = self.workflow.index("Inspect UE 5.8 crypto provider surface")
        build = self.workflow.index("Build RIDGE Game, Editor and optional Dedicated Server")
        self.assertLess(probe, build)
        self.assertIn("Inspect-UE58CryptoProvider.ps1", self.workflow)

    def test_workflow_uploads_crypto_provider_probe_report(self):
        self.assertIn("ridge_ue58_crypto_provider_probe.json", self.workflow)
        self.assertIn("if: always()", self.workflow)


if __name__ == "__main__":
    unittest.main(verbosity=2)
