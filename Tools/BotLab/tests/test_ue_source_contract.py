from __future__ import annotations
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
HEADER = ROOT / "Source/RIDGE/Public/RidgeBotTestController.h"
SOURCE = ROOT / "Source/RIDGE/Private/RidgeBotTestController.cpp"
BUILD = ROOT / "Source/RIDGE/RIDGE.Build.cs"
PROJECT = ROOT / "RIDGE.uproject"
SESSION_LOGIN = ROOT / "Source/RIDGE/Private/RidgeSessionLoginSubsystem.cpp"


class UnrealSourceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.header = HEADER.read_text(encoding="utf-8")
        cls.source = SOURCE.read_text(encoding="utf-8")
        cls.build = BUILD.read_text(encoding="utf-8")
        cls.project = json.loads(PROJECT.read_text(encoding="utf-8"))
        cls.session_login = SESSION_LOGIN.read_text(encoding="utf-8")

    def test_project_targets_unreal_58(self):
        self.assertEqual("5.8", self.project["EngineAssociation"])

    def test_ai_and_navigation_modules_are_declared(self):
        self.assertIn('"AIModule"', self.build)
        self.assertIn('"NavigationSystem"', self.build)

    def test_controller_is_server_qa_ai_controller(self):
        self.assertIn("class RIDGE_API ARidgeBotTestController : public AAIController", self.header)
        self.assertIn("StartWaypointRoute", self.header)
        self.assertIn("CancelTestRoute", self.header)
        self.assertIn("FinalizeTelemetryCapture", self.header)

    def test_route_input_is_bounded_and_validated(self):
        self.assertIn("InWaypoints.Num() > 256", self.source)
        self.assertIn("FMath::IsFinite(Waypoint.X)", self.source)
        self.assertIn("SetAllowPartialPath(false)", self.source)
        self.assertIn("SetRequireNavigableEndLocation(true)", self.source)

    def test_route_completion_is_bound_to_active_request(self):
        self.assertIn("RequestID.GetID() != ActiveRequestId.GetID()", self.source)
        self.assertIn("stale_move_completion_ignored", self.source)
        self.assertIn('MarkRouteTerminal(TEXT("failed"), TEXT("stuck_timeout"))', self.source)

    def test_telemetry_is_authority_only_and_finalized(self):
        self.assertIn("if (!HasAuthority() || bTelemetryFinalized)", self.source)
        self.assertIn('TEXT("capture_finalized")', self.source)
        self.assertIn('TEXT("server_world_time_seconds")', self.source)

    def test_movement_and_collision_observability_fields_exist(self):
        for field in (
            "actor_position_cm", "actor_rotation_deg", "speed_cm_s",
            "movement_mode_id", "is_moving_on_ground", "is_falling",
            "is_crouching", "nav_path_status", "nav_partial_path",
            "collision_impact_point_cm", "collision_impact_normal",
        ):
            self.assertIn(field, self.source)

    def test_telemetry_avoids_player_entered_actor_names(self):
        self.assertIn("OtherActor->GetClass()->GetName()", self.source)
        self.assertNotIn("OtherActor->GetName()", self.source)

    def test_secure_gateway_response_cannot_fall_back_to_plaintext_ticket_url(self):
        secure_guard = self.session_login.index('if (Json->HasField(TEXT("transport")))') 
        ticket_parse = self.session_login.index('TEXT("ticket")')
        plaintext_option = self.session_login.index('TEXT("?ridgeJoinTicket=")')
        client_travel = self.session_login.index("PlayerController->ClientTravel")
        self.assertLess(secure_guard, ticket_parse)
        self.assertLess(secure_guard, plaintext_option)
        self.assertLess(secure_guard, client_travel)
        self.assertIn("Plaintext ticket URL fallback გამორთულია", self.session_login)


if __name__ == "__main__":
    unittest.main(verbosity=2)