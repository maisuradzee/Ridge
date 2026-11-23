# RIDGE — OIDC public session gateway

**ეტაპი:** Stage 5 / player-facing session entry  
**მდგომარეობა:** Provider-agnostic OIDC JWT verification + public session allocation/ticket endpoint committed; actual identity-provider tenant and UE client travel wiring remain deployment/integration work.

## 1. Public endpoint

\`POST /v1/gateway/session\`

Request:

    Authorization: Bearer <OIDC-JWT-issued-for-ridge-game-api>
    Content-Type: application/json

    {
      "region": "ge-tbilisi"
    }

The region defaults to \`ge-tbilisi\` if omitted. The endpoint does not accept a player ID from the client and does not accept \`x-ridge-player-id\` as proof of identity.

Successful response (sensitive values shown as placeholders):

    {
      "sessionId": "<session-uuid>",
      "expiresAt": "<ticket-expiry-iso8601>",
      "server": {
        "host": "game-server.example.net",
        "port": 7777,
        "region": "ge-tbilisi",
        "protocolVersion": "ridge-0.6"
      },
      "join": {
        "ticket": "<short-lived-256-bit-bearer-ticket>",
        "claimAttemptId": "<stable-uuid>"
      },
      "connectionOptions": "ridgeJoinTicket=<ticket>?ridgeClaimAttemptId=<uuid>",
      "connectUrl": "game-server.example.net:7777?ridgeJoinTicket=<ticket>?ridgeClaimAttemptId=<uuid>"
    }

The canonical backend player identifier is intentionally not returned. The ticket and attempt ID must be treated as secrets until the Unreal server consumes them. Never log them, include them in analytics, crash reports, deep-link telemetry, or support logs.

If the account already has a connected session, the gateway responds HTTP 409 \`PLAYER_SESSION_ALREADY_CONNECTED\`. The gateway allocates a slot only through the trusted session registry, then issues a ticket for that exact allocation. If ticket issuance fails for a newly created allocation, the gateway attempts a compensating release.

## 2. OIDC verification contract

Environment:

- \`RIDGE_OIDC_ISSUER\` — exact HTTPS issuer URL; must equal the JWT \`iss\`.
- \`RIDGE_OIDC_AUDIENCE\` — RIDGE API audience; must be present in JWT \`aud\`.
- \`RIDGE_OIDC_JWKS_URL\` — HTTPS URL for the provider's JSON Web Key Set.

The verifier:
- accepts compact signed JWTs using RS256 only;
- loads the key by \`kid\` from the configured JWKS endpoint, never from a token-supplied \`jku\`, \`x5u\` or embedded \`jwk\`;
- accepts RSA signing keys with at least 2048-bit modulus and exponent 65537;
- verifies the cryptographic signature and exact \`iss\`, \`aud\`, optional multi-audience \`azp\`, mandatory \`sub\`, \`iat\` and \`exp\`, plus \`nbf\` when present;
- caches JWKS keys for five minutes and forces one refresh when a token uses an unknown \`kid\`, supporting normal key rotation;
- rejects unsupported critical JWT header parameters and tokens larger than the configured bound.

The stable backend ID is derived as \`oidc_\` plus SHA-256 of \`issuer + NUL + subject\`. It is deterministic for the same issuer/subject pair and does not expose the original subject or email to the game client. If the provider changes a subject, that is a new identity and requires an account-link/migration workflow; do not silently key accounts by email.

The verifier does not implement the external provider's authorization-code flow, redirect URI, state/nonce issuance, MFA policy, account recovery, or account linking. Those belong in the identity provider/client integration. The caller must present a signed JWT explicitly issued for the configured RIDGE audience.

## 3. Production deployment and TLS

The RIDGE Node API uses an HTTP listener behind a trusted TLS reverse proxy. The Node process itself is restricted to loopback or a private RFC1918/IPv6 ULA bind address; wildcard and public-interface binds are refused at startup. Production startup requires:
- PostgreSQL-backed storage (ephemeral memory storage is refused in production);
- all three OIDC environment variables;
- `RIDGE_SERVER_PROVISIONING_TOKEN` (orchestrator-only credential used to issue/rotate/revoke per-server tokens);
- \`RIDGE_TRUST_PROXY=true\`;
- a reverse proxy that terminates TLS, removes any client-supplied \`X-Forwarded-Proto\`, then sets \`X-Forwarded-Proto: https\`;
- the Node listener bound to loopback/private interface and not directly reachable from the public internet.

Example environment (replace placeholders with values from the chosen provider and deployment secret store):

    RIDGE_ENV=production
    RIDGE_STORAGE=postgres
    RIDGE_HOST=127.0.0.1
    RIDGE_TRUST_PROXY=true
    RIDGE_OIDC_ISSUER=https://identity.example.com/
    RIDGE_OIDC_AUDIENCE=ridge-game-api
    RIDGE_OIDC_JWKS_URL=https://identity.example.com/.well-known/jwks.json
    RIDGE_SERVER_PROVISIONING_TOKEN=<orchestrator-only-secret>

Never set \`RIDGE_TRUST_PROXY=true\` when untrusted clients can reach the Node listener directly; the trusted proxy must overwrite forwarding headers. The ingress must also enforce request rate limits, connection limits and body-size/time limits. The current Node process does not provide a distributed rate limiter.

The public gateway endpoint is disabled when OIDC is not configured. Production refuses to start without OIDC configuration and a trusted HTTPS reverse proxy. Development can run with OIDC configured and an HTTP JWKS URL only when that URL points to loopback (127.0.0.1, localhost or ::1); this exception is not available in production.

## 4. Unreal client handoff

After the user authenticates, the client sends the provider-issued JWT to the gateway and receives the one-time response above. The UE client then opens the supplied \`connectUrl\` (or equivalent host/port/options) immediately, before \`expiresAt\`.

The bearer ticket is a credential, not harmless URL metadata. The application must:
- avoid writing the connect URL or options into application logs, analytics, crash breadcrumbs or clipboard history;
- avoid reusing the same response to open a different connection attempt;
- preserve \`claimAttemptId\` exactly for a retry of the same connection attempt;
- request a new gateway session after expiry, a completed/failed login, or a different connection attempt.

The server binds \`ridgeJoinTicket\` and \`ridgeClaimAttemptId\` in \`PreLoginAsync\`, consumes the ticket on the assigned shard, and only then binds the canonical identity to the server-side PlayerState. The claim is single-use except for the same-attempt retry after a lost backend response.

**Important:** HTTPS between the game client and gateway protects the HTTP response, but it does not automatically encrypt the later Unreal game connection. Before production, enable and verify appropriate Unreal network encryption/transport protection so the bearer ticket in initial connection options cannot be read or replayed by an on-path observer. This is an open acceptance gate.

## 5. Error contract

| HTTP | Code | Meaning / client action |
|---|---|---|
| 201 | — | session reserved and join ticket issued; connect immediately |
| 400 | \`INVALID_JSON_BODY\`, \`HTTPS_REQUIRED\` | correct request format or transport |
| 401 | \`OIDC_TOKEN_INVALID\` | authenticate again; do not retry the same invalid token |
| 409 | \`PLAYER_SESSION_ALREADY_CONNECTED\` | existing live session; resolve reconnect/duplicate client before another login |
| 503 | \`OIDC_NOT_CONFIGURED\`, \`OIDC_IDENTITY_SERVICE_UNAVAILABLE\`, \`NO_AVAILABLE_SHARD\` | service/configuration/capacity unavailable; retry with backoff or show service unavailable |

The endpoint uses \`Cache-Control: no-store\`. Do not cache session responses or tickets in shared caches.

## 6. Test coverage and acceptance boundary

Automated tests cover RS256 verification, cache reuse, unknown-kid refresh, invalid signature, wrong issuer/audience, expiry/nbf/iat checks, unsupported JWT header key injection, JWKS transport restrictions, stable pseudonymous player ID derivation, and an end-to-end public session flow against a local JWKS test server.

These tests do not prove the chosen external provider's tenant configuration, real authorization-code flow, MFA/account recovery, real TLS reverse-proxy deployment, encrypted Unreal game transport, Windows UBT/UHT compilation, two-client PIE, or true 500-player Unreal capacity. Those remain explicit integration gates.


## 7. CI verification — 2026-11-23

Revision `d0490b75aa471e64da986e72627a74790ee2abd1` passed both workflows:

- Stage 5 Multiplayer Preflight: https://github.com/maisuradzee/Ridge/actions/runs/45134162859
- PostgreSQL 16 Integration: https://github.com/maisuradzee/Ridge/actions/runs/45134168625

| Gate | Result |
|---|---:|
| Python / BotLab / Unreal source regression | 69/69 PASS |
| Unreal project static validation | PASS |
| Load-runner unit tests | 6/6 PASS |
| Backend Node suite | 51 PASS / 0 FAIL / 2 SKIP |
| PostgreSQL migrations 001–005 | PASS |
| Backend + live PostgreSQL suite | 53 PASS / 0 FAIL / 0 SKIP |
| 500 virtual-client API preflight | 6,995 requests / 0 failures |

The 15-second in-memory development API preflight recorded 437.4 requests/second, p50 0.24 ms, p95 0.45 ms, p99 1.17 ms and max 4.09 ms; maximum observed in-flight HTTP requests was 6. It is an API preflight, not a 500-player Unreal network test.

Machine-readable evidence: `RIDGE_GIS/Data/QA/ridge_stage5_oidc_gateway_20261123.json`.

The workflow does not run UE 5.8 UBT/UHT. Real provider tenant/authorization-code configuration, live TLS deployment, protected Unreal game transport, two-client Dedicated Server/PIE and true 500-player Unreal soak remain unverified.


## 8. Dedicated Server credential lifecycle

Each Dedicated Server process has a separate 256-bit bearer credential bound to a pre-provisioned instance ID. The control plane issues it through:

`POST /v1/control/shards/{serverId}/credentials`

Header: `x-ridge-provisioning-token`. The raw token is returned once. The database stores only a SHA-256 hash with a 90-day expiry. The orchestrator puts the token in the individual process secret store as `RIDGE_SERVER_EVENT_TOKEN` and sets `RIDGE_SERVER_INSTANCE_ID` to the same ID used during provisioning.

The server sends `x-ridge-server-id` and `x-ridge-server-token` on its private requests. Rotation calls the issue endpoint again; the previous credential is invalidated immediately. Revocation uses `POST /v1/control/shards/{serverId}/credentials/revoke`. The `RIDGE_SERVER_PROVISIONING_TOKEN` must never be supplied to game-server processes.

Production startup requires the provisioning token and does not accept a shared `RIDGE_SERVER_EVENT_TOKEN` fallback. A local development-only legacy shared token remains available for existing isolated tests.

See `docs/60_PER_INSTANCE_SERVER_CREDENTIALS_GE.md`.


## 9. Production listener and credential readiness guard — 2026-11-23

The API now refuses to start in production if `RIDGE_HOST` is a wildcard or public IP. Accepted bind targets are loopback, RFC1918 IPv4, and IPv6 Unique Local Addresses. This guard complements (but does not replace) the trusted reverse-proxy TLS requirement. PostgreSQL readiness now includes the per-instance credential registry table; a missing credential table no longer reports a ready session control plane.

Latest verification on commit `e2df4c454c332e9362d7e44ca4044a3f16c8058c`:

- Stage 5 Multiplayer Preflight: [SUCCESS](https://github.com/maisuradzee/Ridge/actions/runs/45137196624)
- PostgreSQL 16 Integration (migrations 001–006): [SUCCESS](https://github.com/maisuradzee/Ridge/actions/runs/45137196583)
- Python/BotLab/Unreal source regression: **72/72 PASS**
- Unreal project static validator: **STATIC_PASS** (UBT/UHT not run)
- Load-runner tests: **6/6 PASS**
- Backend Node regression: **55 PASS / 0 FAIL / 2 SKIP**
- PostgreSQL live backend suite: **57 PASS / 0 FAIL / 0 SKIP**
- 500 virtual-client development API preflight: **6,995 requests / 0 failures / 437.26 req/s**, p50 **0.48 ms**, p95 **0.82 ms**, p99 **1.96 ms**, max **5.43 ms**, max observed in-flight requests **6**

This remains a virtual HTTP API preflight, not a 500-client Unreal Engine soak. Actual OIDC tenant/auth-code setup, production secret manager provisioning and audit, TLS proxy deployment, encrypted Unreal game transport, UE 5.8 UBT/UHT/PIE and true 500-CCU profiling remain open.
