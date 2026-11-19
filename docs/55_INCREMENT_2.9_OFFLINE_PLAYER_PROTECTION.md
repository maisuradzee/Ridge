# RIDGE increment 2.9 — offline player protection guard

Date: 2026-11-19

## Implemented

- Added a server-side domain guard for hostile player-to-player actions.
- A target is eligible for hostile interaction only when the persistence-backed presence evidence identifies a player, a session, an active status, and a lease expiry strictly later than the server's current time.
- Missing, malformed, closed, offline, expired, or unverifiable presence fails closed.
- The guard explicitly does not trust a client-supplied online flag.
- A successful presence check is only a prerequisite; it does not bypass combat, safe-zone, consent, jurisdiction, or other gameplay rules.
- Added tests for valid leases, closed sessions, expired leases, offline status, missing fields, and missing server time.

## Verification

- go test ./... — PASS
- go test -race ./... — PASS
- go vet ./... — PASS
- go build ./... — PASS
- Migration mirror check — PASS (14 ordered migrations)

## Integration boundary

The guard is a domain primitive, not yet wired into every combat, robbery, kidnapping, or property-seizure command. Production enforcement requires every such server-side command to call this guard using a presence record read from the authoritative database/session service. Offline asset protection must also be enforced in the corresponding asset and legal-process services. No client is allowed to override presence or lease expiry.
