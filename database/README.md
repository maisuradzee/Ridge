# PostgreSQL database setup

Apply all migrations in numerical order, migrations/001_initial_schema.sql through migrations/007_server_credential_audit.sql. Migrations 004–007 add shard/session control, one-time join tickets, per-instance server credentials and append-only credential audit events.

It is intentionally not executed by the local prototype. Before applying it to any database:

1. Provision a dedicated development database (never point the first run at production).
2. Create a backend-only database role and store its credential outside source control.
3. Confirm the PostgreSQL version and `pgcrypto` availability.
4. Apply migrations 001–007 using a versioned migration runner; never skip a migration.
5. Test inserts, balanced postings, idempotency, append-only ledger behavior, and rollback.
6. Add the chosen authentication provider mapping and least-privilege grants. Runtime API credentials should not own migration objects or have UPDATE/DELETE permission on audit tables.
7. Verify backup/restore before using persistent player data.

Game clients must not connect directly to PostgreSQL. They communicate with trusted backend services, which validate identity and gameplay authorization.

The initial schema provides the player identity anchor, ledger accounts, double-entry transaction records, append-only ledger entries, job definitions, player jobs, world state, and audit log. Migration 002 adds ordered job checkpoint definitions, immutable server checkpoint events, server-event idempotency, and audit logging. Additional domain migrations (vehicles, businesses, properties, social, government, and world events) will be added after the first vertical slice stabilizes.