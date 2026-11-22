from pathlib import Path
import tempfile
import unittest

from Tools.BotLab.validate_ue_project import validate_project

ROOT = Path(__file__).resolve().parents[3]


class UEProjectIntegrationTests(unittest.TestCase):
    def test_ue58_project_and_bot_controller_are_wired(self):
        report = validate_project(ROOT)
        self.assertEqual(report["status"], "STATIC_PASS", report["checks_detail"])
        self.assertGreaterEqual(report["checks"], 15)
        self.assertEqual(report["ue_build_status"], "NOT_RUN_STATIC_ONLY")
        self.assertEqual(report["runtime_status"], "NOT_RUN_STATIC_ONLY")

    def test_missing_project_descriptor_is_a_failure_not_a_false_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            report = validate_project(Path(directory))
        self.assertEqual(report["status"], "FAIL")
        self.assertEqual(report["ue_build_status"], "NOT_RUN_STATIC_ONLY")


if __name__ == "__main__":
    unittest.main()