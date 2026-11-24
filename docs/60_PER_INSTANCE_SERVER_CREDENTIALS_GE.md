# RIDGE — Per-instance Dedicated Server credentials

**Stage:** 5 / production shard security  
**Status:** Backend provisioning, hash-only credential registry, per-instance request authentication, rotation and revocation are implemented in source. Static and PostgreSQL CI pass; production secret-manager and UE runtime acceptance remain open.

## 1. Security model

Every Dedicated Server process receives one independent random 256-bit bearer credential.

- RIDGE_SERVER_INSTANCE_ID is the stable unique server process/instance ID created by the deployment orchestrator before boot.
- RIDGE_SERVER_EVENT_TOKEN is the secret credential issued for exactly that instance ID.
- RIDGE_SERVER_PROVISIONING_TOKEN exists only in the RIDGE control plane and deployment orchestrator. It is never sent to a game-server process or client.
- Each private Dedicated Server request carries both x-ridge-server-id and x-ridge-server-token.
- Production has no shared server-token fallback. A development-only compatibility path remains for isolated local tests.

The token has 32 random bytes encoded as a 43-character Base64URL value. PostgreSQL stores only its lowercase SHA-256 digest, credential UUID, expiry and revocation timestamp. The plaintext token is returned once by the issue endpoint and is never logged.

## 2. Environment separation

### RIDGE API / control plane

Required in production:

    RIDGE_ENV=production
    RIDGE_STORAGE=postgres
    DATABASE_URL=<private-postgres-connection>
    RIDGE_SERVER_PROVISIONING_TOKEN=<secret-store-control-plane-token>
    RIDGE_SERVER_PROVISIONING_ACTOR_ID=ridge-orchestrator-prod-01
    RIDGE_GATEWAY_TOKEN=<internal-session-gateway-token>
    RIDGE_SERVER_EVENT_TOKEN=
    RIDGE_TRUST_PROXY=true
    RIDGE_OIDC_ISSUER=https://identity.example.com/
    RIDGE_OIDC_AUDIENCE=ridge-game-api
    RIDGE_OIDC_JWKS_URL=https://identity.example.com/.well-known/jwks.json

The API may omit RIDGE_SERVER_EVENT_TOKEN in production. Per-instance tokens are verified from the database. The provisioner token is distinct from the player gateway token.

### One Dedicated Server process

    RIDGE_ENV=production
    RIDGE_API_BASE_URL=https://backend-domain
    RIDGE_SERVER_INSTANCE_ID=ge-tbilisi-zone-a-process-00017
    RIDGE_SERVER_EVENT_TOKEN=<token-issued-for-this-exact-instance-id>
    RIDGE_SERVER_HOST=game17.example.net
    RIDGE_SERVER_PORT=7777
    RIDGE_SERVER_REGION=ge-tbilisi
    RIDGE_SERVER_MAX_PLAYERS=100
    RIDGE_PROTOCOL_VERSION=ridge-0.6

Do not inject the provisioning token or gateway token into Dedicated Server processes. Do not put RIDGE_SERVER_EVENT_TOKEN in DefaultEngine.ini, client configuration, game assets, command-line arguments, build artifacts or logs.

## 3. Issue before process startup

The orchestrator chooses a unique instance ID and requests a credential:

    POST /v1/control/shards/{serverId}/credentials
    x-ridge-provisioning-token: <provisioning-secret>

Example response:

    {
      "serverId": "ge-tbilisi-zone-a-process-00017",
      "credentialId": "c3a3...",
      "token": "<one-time-256-bit-token>",
      "expiresAt": "..."
    }

The API returns HTTP 201 and Cache-Control: no-store. Persist the token directly into the secret manager for that instance. Do not print the response to CI logs or terminal output. Start the Dedicated Server with the same serverId as RIDGE_SERVER_INSTANCE_ID and the issued token as RIDGE_SERVER_EVENT_TOKEN.

The Dedicated Server then registers itself using its own credential:

    POST /v1/internal/shards/register
    x-ridge-server-id: ge-tbilisi-zone-a-process-00017
    x-ridge-server-token: <that-instance-token>

The request body must contain the same serverId. A mismatched identity header is rejected.

## 4. Rotation and revocation

### Rotation

Issue a new credential for the same instance ID:

    POST /v1/control/shards/{serverId}/credentials
    x-ridge-provisioning-token: <provisioning-secret>

The new token replaces the previous hash atomically. The old token becomes invalid immediately. The orchestrator must update that instance's secret-manager version and restart/redeploy the process with the new token. Avoid rotating while the old process is still expected to send heartbeats or serve players; use a planned drain/restart sequence.

### Revocation

    POST /v1/control/shards/{serverId}/credentials/revoke
    x-ridge-provisioning-token: <provisioning-secret>

The selected instance credential becomes invalid. Other shard credentials are not affected. Revoke should be paired with shard draining/offline and instance termination.

The active credential table retains only the current credential per serverId. A separate append-only event table records issuance, rotation and revocation without storing the bearer token or its digest.

## 5. Authorized request coverage

The per-instance credential protects:
- shard registration;
- shard heartbeat and offline transitions;
- join-ticket claim;
- exact player session release;
- internal job acceptance, completion and checkpoint recording.

The shard list and credential issue/rotate/revoke endpoints are control-plane operations and require the provisioning token, not a game-server token.

The per-instance credential is not an account login token. Player identity is separately established by the OIDC gateway, and the one-time join ticket is separately bound to one player session and one shard.

## 6. Failure and recovery behavior

- Missing, incorrect, expired or revoked server credential: HTTP 403.
- Mismatched x-ridge-server-id and route/body server ID: HTTP 403.
- Missing server instance ID on job events: rejected; the API never guesses the shard from the token alone.
- Credential rotation: old token fails immediately; new token is accepted for that exact server ID.
- Server shutdown: mark the shard offline; the registry expires all active sessions on that instance.
- Server process crash: heartbeat becomes stale after 45 seconds; allocator excludes the shard and expires a player's stale previous session when that account attempts a new allocation.

## 7. Current implementation boundary

Migrations: database/migrations/006_dedicated_server_credentials.sql and database/migrations/008_credential_audit_actor.sql.

The registry stores only SHA-256 token hashes, issues 90-day credentials by default, rotates by replacing the active hash and supports explicit revocation. Production startup requires RIDGE_SERVER_PROVISIONING_TOKEN, RIDGE_SERVER_PROVISIONING_ACTOR_ID and PostgreSQL migration 008 (in addition to migrations 004–007). The old shared RIDGE_SERVER_EVENT_TOKEN fallback is accepted only in development/test mode.

Still required before production:
- attach the issuance response to a production secret manager/orchestrator and prove secret redaction;
- connect the configured service principal to individually authenticated orchestrator/operator identities; current events identify the trusted provisioning service, not a human operator;
- provision and restart a real Windows/Linux UE Dedicated Server process using the per-instance secret;
- verify no client package, crash log, analytics event or process argument leaks the token;
- compile UE 5.8 UBT/UHT and run real registration, heartbeat, join, logout and rotation tests;
- use per-server credential rotation together with a graceful shard drain, not while active players are being served.

See also:
- docs/57_UNREAL_DEDICATED_SERVER_REGISTRATION_GE.md
- docs/58_JOIN_TICKET_AND_PRELOGIN_FLOW_GE.md
- docs/59_PUBLIC_OIDC_GATEWAY_GE.md


## 8. Latest CI verification — 2026-11-23

On commit `e2df4c454c332e9362d7e44ca4044a3f16c8058c`:

- Stage 5 source/regression and development API preflight: [SUCCESS](https://github.com/maisuradzee/Ridge/actions/runs/45137196624)
- PostgreSQL 16 live integration, migrations 001–006: [SUCCESS](https://github.com/maisuradzee/Ridge/actions/runs/45137196583)
- Per-instance credential registry and rotation/revocation tests are included in the 55-pass backend regression and 57-pass PostgreSQL live suite.
- The PostgreSQL readiness check now verifies the credential table exists.
- Production listener guard has explicit tests for wildcard/public rejection and loopback/private-IP acceptance.

The CI does not provision credentials into a real external secret manager, verify redaction from a production orchestrator, compile UE 5.8, or execute a real Dedicated Server credential rotation during live players. Those remain operational/runtime gates.


## 9. Credential audit history — Stage 5 increment (2026-11-24)

Migration database/migrations/007_server_credential_audit.sql adds ridge.dedicated_server_credential_events. It records:
- issued when a credential is first created or re-issued after expiry/revocation;
- rotated when an unexpired active credential is atomically replaced, including the previous credential UUID;
- revoked when the current credential is revoked.

The event table contains credential UUIDs, actor type/ID and timestamps. It never stores bearer tokens or SHA-256 token digests. An identity-sequence column gives stable newest-first ordering. A PostgreSQL trigger rejects UPDATE and DELETE statements against the audit events.

### Protected audit endpoint

    GET /v1/control/shards/{serverId}/credentials/audit?limit=50
    x-ridge-provisioning-token: <provisioning-secret>

The endpoint is available only to the provisioner token and through the private control-plane ingress allowlist. limit must be an integer from 1 to 100. Example response:

    {
      "serverId": "ge-tbilisi-zone-a-process-00017",
      "events": [
        {
          "eventId": "...",
          "serverId": "ge-tbilisi-zone-a-process-00017",
          "credentialId": "...",
          "previousCredentialId": null,
          "action": "issued",
          "occurredAt": "..."
        }
      ]
    }

The API response intentionally omits plaintext tokens and token hashes. Issue, rotation and revocation each write the corresponding audit event inside the same PostgreSQL transaction as the credential change. A failed audit insert rolls back the credential change. A per-server transaction-scoped advisory lock serializes concurrent issue/revoke operations.

Migration 008 adds actor_type and actor_id. After successful provisioning-token authentication, the API obtains this identity only from RIDGE_SERVER_PROVISIONING_ACTOR_ID on the server; request headers or JSON fields supplied by a caller are ignored. Existing migration-007 rows are backfilled as actor_type=service and actor_id=legacy-provisioner. Production startup requires a stable service-principal ID. This is service-level attribution only: because the current provisioner credential is shared, it does not identify a human operator. Individual operator attribution still requires an authenticated orchestrator/operator identity integration. The SQL trigger protects normal application DML; database owners/superusers can still alter database objects and must be governed separately.

### Validation

- Memory registry lifecycle tests cover issued → rotated → revoked and cross-shard isolation.
- HTTP tests verify that audit reads require the provisioning token and reject invalid limits.
- PostgreSQL integration verifies event order/linkage and confirms UPDATE/DELETE are rejected by the trigger.
- PostgreSQL readiness now requires the audit table and migration 008's actor_id column.


## 10. Trusted provisioning service actor — Stage 5 increment (2026-11-24)

Migration `008_credential_audit_actor.sql` adds `actor_type` and `actor_id` to the append-only audit table. New issue/rotation/revoke events must include the actor fields in the same PostgreSQL transaction as the credential mutation.

Production configuration:

    RIDGE_SERVER_PROVISIONING_ACTOR_ID=ridge-orchestrator-prod-01

Rules:
- The value is a stable non-secret service-principal identifier (1–80 characters, letters/numbers followed by letters/numbers/dot/underscore/colon/hyphen).
- The API reads it from its protected process environment after validating the provisioner bearer token.
- The API does not accept an actor ID from request headers, query parameters or JSON.
- Production startup fails closed when this ID is missing or malformed.
- The development fallback is explicitly marked `ridge-development-orchestrator` or `ridge-development-compatibility`.
- Actor type is currently `service`; user-level attribution is not implemented.

This improves service-level traceability, but does not prove which human initiated an orchestrator action when multiple operators share the same provisioner secret. That requires a future authenticated operator identity and authorization integration.
