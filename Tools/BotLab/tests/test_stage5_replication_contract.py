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
        cls.backend_server_source = (ROOT / "backend/src/server.mjs").read_text(encoding="utf-8")
        cls.session_registry_source = (ROOT / "backend/src/session-registry.mjs").read_text(encoding="utf-8")
        cls.backend_oidc_source = (ROOT / "backend/src/oidc-verifier.mjs").read_text(encoding="utf-8")
        cls.gateway_integration_test = (ROOT / "backend/test/gateway-auth.test.mjs").read_text(encoding="utf-8")
        cls.client_login_header = (ROOT / "Source/RIDGE/Public/RidgeSessionLoginSubsystem.h").read_text(encoding="utf-8")
        cls.client_login_source = (ROOT / "Source/RIDGE/Private/RidgeSessionLoginSubsystem.cpp").read_text(encoding="utf-8")
        cls.game_config = (ROOT / "Config/DefaultGame.ini").read_text(encoding="utf-8")
        cls.mission_source = (ROOT / "Source/RIDGE/Private/RidgeMissionCheckpoint.cpp").read_text(encoding="utf-8")

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
        self.assertIn("refusing to advertise a loopback address", self.backend_bridge)
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


    def test_prelogin_async_preserves_engine_checks_and_uses_the_documented_delegate_signature(self) -> None:
        self.assertIn("virtual void PreLoginAsync(", self.game_mode_header)
        self.assertIn("const FString& Options", self.game_mode_header)
        self.assertIn("const FUniqueNetIdRepl& UniqueId", self.game_mode_header)
        self.assertIn("const FOnPreLoginCompleteDelegate& OnComplete", self.game_mode_header)
        self.assertIn("Super::PreLoginAsync(", self.game_mode_source)
        self.assertIn("Completion.ExecuteIfBound", self.game_mode_source)
        self.assertIn("UGameplayStatics::ParseOption(Options, TEXT(\"ridgeJoinTicket\"))", self.game_mode_source)
        self.assertIn('UGameplayStatics::ParseOption(Options, TEXT("ridgeClaimAttemptId"))', self.game_mode_source)
        self.assertNotIn("FGuid::NewGuid()", self.game_mode_source)

    def test_dedicated_server_rejects_missing_or_unverified_join_tickets(self) -> None:
        self.assertIn("GetNetMode() == NM_DedicatedServer", self.game_mode_source)
        self.assertIn("A valid RIDGE join ticket and claim attempt ID are required.", self.game_mode_source)
        self.assertIn("Backend->ClaimJoinTicket(", self.game_mode_source)
        self.assertIn("RIDGE join ticket verification failed.", self.game_mode_source)
        self.assertIn("VerifiedClaimsByTicket.Add(Ticket", self.game_mode_source)

    def test_init_new_player_binds_only_the_preverified_session_claim(self) -> None:
        self.assertIn("ARidgeGameMode::InitNewPlayer(", self.game_mode_source)
        self.assertIn("VerifiedClaimsByTicket.Find(Ticket)", self.game_mode_source)
        self.assertIn("RIDGE join ticket verification is missing or expired.", self.game_mode_source)
        self.assertIn("PendingJoinClaimsByController.Add", self.game_mode_source)

    def test_postlogin_assigns_canonical_identity_and_kicks_unverified_connections(self) -> None:
        self.assertIn("ARidgeGameMode::PostLogin(", self.game_mode_source)
        self.assertIn("RidgeState->SetVerifiedPlayerId(Claim.PlayerId)", self.game_mode_source)
        self.assertIn("GameSession->KickPlayer", self.game_mode_source)
        self.assertIn("pending join claim expired", self.game_mode_source)
        self.assertIn("GameFramework/GameSession.h", self.game_mode_source)
        self.assertIn("GameFramework/PlayerController.h", self.game_mode_source)
        self.assertIn("ActiveJoinClaimsByController.Add", self.game_mode_source)

    def test_logout_releases_backend_session_and_expired_pending_claims_are_pruned(self) -> None:
        self.assertIn("ARidgeGameMode::Logout(", self.game_mode_source)
        self.assertIn("ReleaseJoinClaim(*ActiveClaim)", self.game_mode_source)
        self.assertIn("Backend->ReleasePlayerSession(Claim.PlayerId, Claim.SessionId)", self.game_mode_source)
        self.assertIn("PruneExpiredJoinClaims", self.game_mode_source)
        self.assertIn("JoinClaimCleanupTimer", self.game_mode_header)
        self.assertIn("5.0f", self.game_mode_source)

    def test_canonical_account_id_is_server_only_and_public_id_remains_replicated(self) -> None:
        self.assertIn("FString VerifiedPlayerId;", self.player_state_header)
        self.assertIn("bool SetVerifiedPlayerId", self.player_state_header)
        self.assertIn("FString GetBackendPlayerId() const", self.player_state_header)
        self.assertIn("DOREPLIFETIME(ARidgePlayerState, RidgePublicId)", self.player_state_source)
        self.assertNotIn("DOREPLIFETIME(ARidgePlayerState, VerifiedPlayerId)", self.player_state_source)
        self.assertIn("VerifiedPlayerId = InVerifiedPlayerId", self.player_state_source)

    def test_backend_job_and_checkpoint_requests_use_canonical_backend_identity(self) -> None:
        self.assertIn("RidgeState->GetBackendPlayerId()", self.character_source)
        self.assertIn("Backend->AcceptDeliveryJob(BackendPlayerId)", self.character_source)
        self.assertIn("RidgeState->GetBackendPlayerId()", self.mission_source)
        self.assertIn("Backend->RecordDeliveryCheckpoint(BackendPlayerId", self.mission_source)
        self.assertNotIn("RidgeState->RidgePublicId", self.character_source)
        self.assertNotIn("RidgeState->RidgePublicId", self.mission_source)

    def test_backend_join_claim_and_release_are_private_server_only_operations(self) -> None:
        self.assertIn("void ClaimJoinTicket(", self.backend_header)
        self.assertIn("void ReleasePlayerSession(", self.backend_header)
        self.assertIn("/join/claim", self.backend_bridge)
        self.assertIn("/release", self.backend_bridge)
        self.assertIn('TEXT("x-ridge-server-token")', self.backend_bridge)
        self.assertIn("ClaimedServerId != Self->ServerId", self.backend_bridge)



    def test_production_api_listener_is_bound_to_loopback_or_private_network(self) -> None:
        self.assertIn("function isPrivateBindHost(host)", self.backend_server_source)
        self.assertIn("isPrivateBindHost(HOST)", self.backend_server_source)
        self.assertIn("public and wildcard listeners are forbidden", self.backend_server_source)
        self.assertIn("from 'node:net'", self.backend_server_source)


    def test_unreal_client_uses_oidc_gateway_and_travels_with_single_use_ticket(self) -> None:
        self.assertIn("RequestAndConnect", self.client_login_header)
        self.assertIn("/v1/gateway/session", self.client_login_source)
        self.assertIn('TEXT("Authorization"), TEXT("Bearer ") + OidcAccessToken', self.client_login_source)
        self.assertIn('TEXT("region")', self.client_login_source)
        self.assertIn("PlayerController->ClientTravel(ConnectUrl, TRAVEL_Absolute, false, FGuid())", self.client_login_source)
        self.assertIn('TEXT("?ridgeJoinTicket=")', self.client_login_source)
        self.assertIn('TEXT("?ridgeClaimAttemptId=")', self.client_login_source)
        self.assertIn("FDateTime::ParseIso8601", self.client_login_source)
        self.assertIn("IsValidJoinTicket", self.client_login_source)
        self.assertIn("GatewayBaseUrl", self.game_config)

    def test_client_login_never_uses_dedicated_server_or_gateway_service_secrets(self) -> None:
        self.assertNotIn("RIDGE_SERVER_EVENT_TOKEN", self.client_login_source)
        self.assertNotIn("RIDGE_SERVER_PROVISIONING_TOKEN", self.client_login_source)
        self.assertNotIn("RIDGE_GATEWAY_TOKEN", self.client_login_source)
        self.assertNotIn("x-ridge-server-token", self.client_login_source)
        self.assertNotIn("x-ridge-gateway-token", self.client_login_source)
        self.assertNotIn("UE_LOG", self.client_login_source)
        self.assertIn("https://", self.client_login_source)
        self.assertIn('GatewayBaseUrl.StartsWith(TEXT("http://")', self.client_login_source)
        self.assertIn("Authority == Host", self.client_login_source)
        self.assertIn("Authority.StartsWith(Host + TEXT(\":\"))", self.client_login_source)
        self.assertNotIn('GatewayBaseUrl.StartsWith(TEXT("http://127.0.0.1")', self.client_login_source)

    def test_public_gateway_derives_player_identity_only_from_verified_oidc_claims(self) -> None:
        self.assertIn("url.pathname === '/v1/gateway/session'", self.backend_server_source)
        self.assertIn("request.method === 'POST'", self.backend_server_source)
        self.assertIn("verifyAuthorizationHeader", self.backend_server_source)
        self.assertIn("deriveCanonicalPlayerId(identity.issuer, identity.subject)", self.backend_server_source)
        self.assertIn("RIDGE_OIDC_ISSUER", self.backend_server_source)
        self.assertIn("RIDGE_OIDC_AUDIENCE", self.backend_server_source)
        self.assertIn("RIDGE_OIDC_JWKS_URL", self.backend_server_source)
        self.assertIn("deriveCanonicalPlayerId(identity.issuer, identity.subject)", self.backend_server_source)
        self.assertIn("RIDGE_TRUST_PROXY", self.backend_server_source)
        self.assertIn("Production RIDGE public gateway requires a trusted HTTPS reverse proxy", self.backend_server_source)
        self.assertIn("Production RIDGE API requires OIDC issuer, audience and JWKS configuration", self.backend_server_source)
        self.assertNotIn("x-ridge-player-id", self.backend_server_source[self.backend_server_source.index("url.pathname === '/v1/gateway/session'"):])

    def test_oidc_verifier_uses_configured_https_jwks_rs256_and_standard_claim_checks(self) -> None:
        self.assertIn("header.alg !== 'RS256'", self.backend_oidc_source)
        self.assertIn("verifySignature('RSA-SHA256'", self.backend_oidc_source)
        self.assertIn("parsedJwksUrl.protocol !== 'https:'", self.backend_oidc_source)
        self.assertIn("claims.iss !== issuer", self.backend_oidc_source)
        self.assertIn("tokenAudiences.includes(audience)", self.backend_oidc_source)
        self.assertIn("claims.exp", self.backend_oidc_source)
        self.assertIn("claims.sub", self.backend_oidc_source)
        self.assertIn("redirect: 'error'", self.backend_oidc_source)

    def test_public_gateway_end_to_end_test_covers_oidc_allocation_ticket_claim_and_duplicate_login(self) -> None:
        self.assertIn("public OIDC gateway allocates a shard", self.gateway_integration_test)
        self.assertIn("/v1/gateway/session", self.gateway_integration_test)
        self.assertIn("/join/claim", self.gateway_integration_test)
        self.assertIn("PLAYER_SESSION_ALREADY_CONNECTED", self.gateway_integration_test)
        self.assertIn("RIDGE_OIDC_JWKS_URL", self.gateway_integration_test)

    def test_gateway_and_game_server_credentials_are_separate(self) -> None:
        self.assertIn("RIDGE_GATEWAY_TOKEN", self.backend_server_source)
        self.assertIn("x-ridge-gateway-token", self.backend_server_source)
        self.assertIn("RIDGE_SERVER_EVENT_TOKEN", self.backend_server_source)
        self.assertIn("x-ridge-server-token", self.backend_server_source)
        self.assertIn("requireGateway(request)", self.backend_server_source)
        self.assertIn("async function requireGameServer(request, routeServerId, sessionRegistry)", self.backend_server_source)
        self.assertIn("await requireGameServer(request,", self.backend_server_source)
        self.assertIn("requireServerProvisioner(request)", self.backend_server_source)
        self.assertIn("requireGateway(request);", self.backend_server_source)


    def test_production_dedicated_servers_use_preprovisioned_per_instance_credentials(self) -> None:
        self.assertIn("RIDGE_SERVER_INSTANCE_ID", self.backend_bridge)
        self.assertIn('TEXT("x-ridge-server-id")', self.backend_bridge)
        self.assertIn("RIDGE_SERVER_PROVISIONING_TOKEN", self.backend_server_source)
        self.assertIn("SERVER_PROVISIONING_FORBIDDEN", self.backend_server_source)
        self.assertIn("authenticateServerCredential", self.backend_server_source)
        self.assertIn("issueServerCredential", self.backend_server_source)
        self.assertIn("revokeServerCredential", self.backend_server_source)
        self.assertIn("ENV !== 'production' && GAME_SERVER_TOKEN", self.backend_server_source)
        self.assertIn("Production RIDGE API requires RIDGE_SERVER_PROVISIONING_TOKEN", self.backend_server_source)

    def test_per_instance_server_credential_migration_and_registry_contract_exist(self) -> None:
        self.assertTrue((ROOT / "database/migrations/006_dedicated_server_credentials.sql").exists())
        self.assertIn("dedicated_server_credentials", self.session_registry_source)
        self.assertIn("to_regclass('ridge.dedicated_server_credentials') AS credentials", self.session_registry_source)
        self.assertIn("RIDGE_SERVER_INSTANCE_ID is required in production", self.backend_bridge)

    def test_backend_secret_is_not_marked_for_network_replication(self) -> None:
        self.assertIn('GetEnvironmentVariable(TEXT("RIDGE_SERVER_EVENT_TOKEN"))', self.backend_bridge)
        self.assertNotIn("DOREPLIFETIME", self.backend_bridge)
        self.assertNotIn("RIDGE_SERVER_EVENT_TOKEN", self.engine_config)


if __name__ == "__main__":
    unittest.main(verbosity=2)
