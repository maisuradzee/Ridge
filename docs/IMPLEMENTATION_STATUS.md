# RIDGE — Implementation Status

Updated: 2026-11-19

## Verified repository starting point

At the time this baseline was inspected, the default branch contained only a seven-byte `README.md` with the heading `# Ridge`. It did not contain the starter archive source tree. The local RIDGE 2.6 starter archive was therefore used as the implementation reference, not represented as already committed source in this repository.

The repository permissions available to the connected GitHub account include push access. Work is isolated in branch `codex/ridge-foundation-2.7`; the default branch is not modified.

## Existing 2.6 foundation (from the local starter archive)

The starter contains:
- Go API and node-agent executables.
- PostgreSQL persistence repositories and 13 ordered SQL migrations.
- Authenticated node heartbeat, capacity reservation, session handoff and recovery flows.
- Durable crash-recovery queue and destination inbox.
- Unreal checkpoint component and recovery bridge source.
- Increment-level test and verification reports.

Important verification limits:
- No registered PostgreSQL driver or live PostgreSQL/PostGIS integration was available in the inspected environment.
- Unreal Engine 5.8 was not installed, so Unreal C++ compilation and dedicated-server runtime were not verified.
- No real multi-node deployment, GIS import, or 500-concurrent-player load test was verified.

## Immediate engineering gates

1. Commit and continuously test the complete source tree in this repository. The current default branch is not yet a usable code checkout.
2. Register a supported PostgreSQL driver in the API executable and provide configuration for database connection, migration execution, pool sizing, TLS, timeouts and graceful shutdown.
3. Add disposable PostgreSQL integration tests for migrations, account/session persistence, capacity reservation races, ticket single-use semantics, recovery job leases, and inbox delivery/ack idempotency.
4. Add CI for Go test, race, vet, build, SQL migration consistency, and Unreal source checks where an Unreal build environment is available.
5. Compile the Unreal 5.8 project and validate the recovery bridge against a real dedicated server.
6. Validate server-to-server TLS/authentication, recovery under node termination, and load at progressively higher player counts before claiming the 500-player target.

## Operating rule

A feature is not production-ready merely because its unit tests pass or its source code exists. Mark it verified only after the relevant integration, runtime, security and load checks have actually run.
