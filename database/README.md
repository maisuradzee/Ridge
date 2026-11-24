# PostgreSQL database setup

Apply all migrations in numerical order, migrations/001_initial_schema.sql through migrations/008_credential_audit_actor.sql. Migrations 004–008 add shard/session control, one-time join tickets, per-instance server credentials, append-only credential audit events and trusted service-principal attribution.

It is intentionally not executed by the local prototype. Before applying it to any database:

1. Provision a dedicated development database (never point the first run at production).
2. Create a backend-only database role and store its credential outside source control.
3. Confirm the PostgreSQL version and `pgcrypto` availability.
4. Apply migrations 001–008 using a versioned migration runner; never skip a migration.
5. Test inserts, balanced postings, idempotency, append-only ledger behavior, and rollback.
6. Add the chosen authentication provider mapping and least-privilege grants. Runtime API credentials should not own migration objects or have UPDATE/DELETE permission on audit tables.
7. Verify backup/restore before using persistent player data.

Game clients must not connect directly to PostgreSQL. They communicate with trusted backend services, which validate identity and gameplay authorization.

The initial schema provides the player identity anchor, ledger accounts, double-entry transaction records, append-only ledger entries, job definitions, player jobs, world state, and audit log. Migration 002 adds ordered job checkpoint definitions, immutable server checkpoint events, server-event idempotency, and audit logging. Additional domain migrations (vehicles, businesses, properties, social, government, and world events) will be added after the first vertical slice stabilizes.

## Migration 009 — Dedicated Server X25519 public keys

Migration `009_dedicated_server_transport_keys.sql` creates the per-instance transport public-key registry. It stores only canonical 32-byte X25519 public keys, key IDs, algorithm and expiry/revocation metadata. Private key material is never sent to or stored in PostgreSQL. A key can remain active until its own expiry so already-issued short-lived envelopes can finish during rotation.


### Transport-key revocation audit

Migration 009 also creates the append-only `ridge.dedicated_server_transport_key_events` audit table. It records `published` and `revoked` actions, authenticated actor type/ID and timestamp. UPDATE/DELETE is rejected by a PostgreSQL trigger. Neither public-key audit events nor the registry store private key bytes, derived secrets or join tickets.
