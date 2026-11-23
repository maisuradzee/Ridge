from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class Stage5ReplicationContractTests(unittest.TestCase):
    """Static source guardrails; these are not substitutes for a live UE network test."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.character_header = (ROOT / "Source/RIDGE/Public/RidgeCharacter.h").read_text(encoding="utf-8")
        cls.character_source = (ROOT / "Source/RIDGE/Private/RidgeCharacter.cpp").read_text(encoding="utf-8")
        cls.player_state_header = (ROOT / "Source/RIDGE/Public/RidgePlayerState.h").read_text(encoding="utf-8")
        cls.player_state_source = (ROOT / "Source/RIDGE/Private/RidgePlayerState.cpp").read_text(encoding="utf-8")
        cls.game_state_header = (ROOT / "Source/RIDGE/Public/RidgeGameState.h").read_text(encoding="utf-8")
        cls.game_state_source = (ROOT / "Source/RIDGE/Private/RidgeGameState.cpp").read_text(encoding="utf-8")
        cls.game_mode_source = (ROOT / "Source/RIDGE/Private/RidgeGameMode.cpp").read_text(encoding="utf-8")
        cls.server_target = (ROOT / "Source/RIDGEServer.Target.cs").read_text(encoding="utf-8")
        cls.engine_config = (ROOT / "Config/DefaultEngine.ini").read_text(encoding="utf-8")
        cls.backend_bridge = (ROOT / "Source/RIDGE/Private/RidgeBackendSubsystem.cpp").read_text(encoding="utf-8")
        cls.backend_header = (ROOT / "Source/RIDGE/Public/RidgeBackendSubsystem.h").read_text(encoding="utf-8")
        cls.game_mode_header = (ROOT / "Source/RIDGE/Public/RidgeGameMode.h").read_text(encoding="utf-8")

    def test_character_uses_actor_and_character_movement_replication(self) -> None:
        self.assertIn("bReplicates = true;", self.character_source)
        self.assertIn("SetReplicateMovement(true);", self.character_source)

    def test_stamina_is_replicated_only_to_the_owner(self) -> None:
        self.assertIn("DOREPLIFETIME_CONDITION(ARidgeCharacter, Stamina, COND_OwnerOnly)", self.character_source)

    def test_sprint_state_is_replicated_to_relevant_clients(self) -> None:
        self.assertIn("DOREPLIFETIME(ARidgeCharacter, bIsSprinting)", self.character_source)
        self.assertIn("ServerSetSprinting", self.character_header)
        self.assertIn("ServerSetSprinting_Implementation", self.character_source)

    def test_server_is_authoritative_for_stamina_mutation(self) -> None:
        self.assertIn("if (HasAuthority())", self.character_source)
        self.assertIn("Stamina = FMath::Max", self.character_source)
        self.assertIn("Stamina = FMath::Min", self.character_source)

    def test_player_public_id_is_replicated(self) -> None:
        self.assertIn("UPROPERTY(Replicated, BlueprintReadOnly", self.player_state_header)
        self.assertIn("DOREPLIFETIME(ARidgePlayerState, RidgePublicId)", self.player_state_source)
        self.assertIn("if (HasAuthority() && RidgePublicId.IsEmpty())", self.player_state_source)

    def test_world_clock_is_replicated_at_low_frequency(self) -> None:
        self.assertIn("UPROPERTY(Replicated, BlueprintReadOnly", self.game_state_header)
        self.assertIn("DOREPLIFETIME(ARidgeGameState, WorldTimeSeconds)", self.game_state_source)
        self.assertIn("NetUpdateFrequency = 2.0f;", self.game_state_source)
        self.assertIn("if (HasAuthority())", self.game_state_source)

    def test_game_mode_wires_ridge_network_game_classes(self) -> None:
        self.assertIn("DefaultPawnClass = ARidgeCharacter::StaticClass()", self.game_mode_source)
        self.assertIn("GameStateClass = ARidgeGameState::StaticClass()", self.game_mode_source)
        self.assertIn("PlayerStateClass = ARidgePlayerState::StaticClass()", self.game_mode_source)

    def test_dedicated_server_target_is_declared(self) -> None:
        self.assertIn("Type = TargetType.Server;", self.server_target)
        self.assertIn('ExtraModuleNames.Add("RIDGE")', self.server_target)

    def test_server_tick_and_client_rate_are_explicit(self) -> None:
        self.assertIn("NetServerMaxTickRate=30", self.engine_config)
        self.assertIn("MaxClientRate=15000", self.engine_config)
        self.assertIn("MaxInternetClientRate=15000", self.engine_config)


    def test_backend_registers_dedicated_server_with_a_unique_process_instance_id(self) -> None:
        self.assertIn("RegisterDedicatedServer", self.backend_header)
        self.assertIn("/v1/internal/shards/register", self.backend_bridge)
        self.assertIn("FGuid::NewGuid()", self.backend_bridge)
        self.assertIn('TEXT("RIDGE_SERVER_ID")', self.backend_bridge)
        self.assertIn('TEXT("RIDGE_SERVER_MAX_PLAYERS")', self.backend_bridge)
        self.assertIn('TEXT("x-ridge-server-token")', self.backend_bridge)

    def test_production_backend_requires_https_and_an_advertisable_host(self) -> None:
        self.assertIn('TEXT("https://")', self.backend_bridge)
        self.assertIn('TEXT("RIDGE_ENV")', self.backend_bridge)
        self.assertIn('TEXT("RIDGE_API_BASE_URL")', self.backend_bridge)
        self.assertIn('TEXT("RIDGE_SERVER_HOST")', self.backend_bridge)
        self.assertIn("cannot advertise a loopback host", self.backend_bridge)
        self.assertIn("bShutdownRequested", self.backend_header)
        self.assertIn('Self->SendShardHeartbeat(0, TEXT("offline"))', self.backend_bridge)
        self.assertIn("refusing to send the server token", self.backend_bridge)

    def test_shard_heartbeat_is_bounded_and_uses_the_internal_registry_route(self) -> None:
        self.assertIn("SendShardHeartbeat", self.backend_header)
        self.assertIn("/heartbeat", self.backend_bridge)
        self.assertIn('TEXT("ready")', self.backend_bridge)
        self.assertIn('TEXT("draining")', self.backend_bridge)
        self.assertIn('TEXT("offline")', self.backend_bridge)
        self.assertIn("CurrentPlayers > ServerMaxPlayers", self.backend_bridge)

    def test_game_mode_registers_and_sends_periodic_server_heartbeat(self) -> None:
        self.assertIn("virtual void BeginPlay() override;", self.game_mode_header)
        self.assertIn("virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;", self.game_mode_header)
        self.assertIn("FTimerHandle ServerHeartbeatTimer", self.game_mode_header)
        self.assertIn("RegisterDedicatedServer()", self.game_mode_source)
        self.assertIn("SetTimer(", self.game_mode_source)
        self.assertIn("15.0f", self.game_mode_source)
        self.assertIn("SendShardHeartbeat(GetNumPlayers(), TEXT(\"ready\"))", self.game_mode_source)
        self.assertIn("MarkDedicatedServerOffline(GetNumPlayers())", self.game_mode_source)

    def test_shard_registration_and_heartbeat_are_server_authority_only(self) -> None:
        self.assertIn("GetNetMode() == NM_Client", self.backend_bridge)
        self.assertIn("HasAuthority()", self.game_mode_source)
        self.assertIn("GetNetMode() == NM_Client", self.game_mode_source)

    def test_backend_secret_is_not_marked_for_network_replication(self) -> None:
        self.assertIn('GetEnvironmentVariable(TEXT("RIDGE_SERVER_EVENT_TOKEN"))', self.backend_bridge)
        self.assertNotIn("DOREPLIFETIME", self.backend_bridge)
        self.assertNotIn("RIDGE_SERVER_EVENT_TOKEN", self.engine_config)


if __name__ == "__main__":
    unittest.main(verbosity=2)
