from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github/workflows/ridge-ue58-windows-build.yml"
BUILD_SCRIPT = ROOT / "Tools/BotLab/Run-UE58BotLabBuild.ps1"
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
            "Engine\\\\Plugins\\\\Experimental\\\\PlatformCrypto\\\\PlatformCrypto.uplugin",
            "Engine\\\\Plugins\\\\Runtime\\\\PacketHandlers\\\\AESGCMHandlerComponent\\\\AESGCMHandlerComponent.uplugin",
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
