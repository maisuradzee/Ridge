# RIDGE — Dedicated Server X25519 transport-key registry

**სტატუსი:** backend public-key publication/retrieval implemented and CI-tested. Client envelope and Unreal packet encryption remain separate, incomplete stages.

## Purpose

The next transport-encryption dependency is a trusted way for each Dedicated Server to publish its short-lived X25519 public key. The registry is the trust bridge between the authenticated server instance and the public Gateway.

## Lifecycle contract

1. The Dedicated Server generates an ephemeral X25519 key pair locally.
2. Its private key remains in process memory and is never serialized into HTTP requests, logs, database rows or telemetry.
3. The server authenticates with its existing per-instance bearer credential and publishes `keyId`, `algorithm=X25519`, raw 32-byte public key (canonical unpadded base64url), and `expiresAt`.
4. The API accepts publication only from a live, authenticated server instance.
5. The key validity window must be at least 15 seconds and no more than 10 minutes from publication.
6. Repeating exactly the same publication is idempotent. Reusing a key ID with different key bytes or expiry is rejected with 409.
7. A rotated key is inserted as a new record; previous unexpired keys are retained so envelopes already issued against them can finish during their short ticket lifetime.
8. Only the trusted Gateway internal token may retrieve the active public key. The registry returns the newest non-expired key for a live server, or an exact key by ID while it remains valid.

## Storage

Migration 009 creates `ridge.dedicated_server_transport_keys`. The database stores public metadata only. It never stores X25519 private keys, derived AEAD keys, join tickets or user identity.

## Endpoints

- `PUT /v1/internal/shards/{serverId}/transport-key` — server credential required; publishes/rotates public key.
- `GET /v1/internal/shards/{serverId}/transport-key` — Gateway service token required; reads newest active public key.
- Exact key retrieval is available through the registry API for a later Gateway integration.

## Explicit boundary

This stage does not yet:
- create X25519 keys inside the Unreal Dedicated Server;
- publish a key from the Unreal runtime automatically;
- bind a client's ephemeral key to a Gateway session reservation;
- encrypt the join-ticket envelope in the Gateway;
- install traffic keys into Unreal PacketHandler;
- enable game packet encryption or change the Production fail-closed constant.

Production gameplay admission stays blocked until all these stages and runtime acceptance tests pass.


## Revocation and audit lifecycle

The transport-key registry now supports immediate, auditable key revocation.

- `POST /v1/internal/shards/{serverId}/transport-key/{keyId}/revoke` allows the authenticated Dedicated Server instance to revoke only its own key.
- `POST /v1/control/shards/{serverId}/transport-key/{keyId}/revoke` allows the trusted deployment Provisioner to revoke a key during emergency response.
- `GET /v1/control/shards/{serverId}/transport-key-audit?limit=50` exposes the bounded audit history to the Provisioner.
- Revocation and event insertion share one PostgreSQL transaction. Repeated revocation is idempotent and does not create duplicate events.
- Audit events record actor type/ID, key ID, action and timestamp, but never key material.
- PostgreSQL UPDATE/DELETE of the audit table is blocked by an append-only trigger.

A revoked key is immediately excluded from Gateway key retrieval, even if its expiry timestamp is still in the future. A new key must use a new key ID.
