-- RIDGE Stage 5: Dedicated Server registry and player session leases.
-- Apply after migrations 001-003. This migration stores routing metadata only;
-- it does not modify player wallets, inventory, ownership, or reward ledgers.

CREATE TABLE IF NOT EXISTS ridge.dedicated_servers (
    server_id TEXT PRIMARY KEY
        CHECK (server_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
    region TEXT NOT NULL
        CHECK (region ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
    host TEXT NOT NULL
        CHECK (char_length(host) BETWEEN 1 AND 253)
        CHECK (host !~ '[ /]' AND host !~ '[[:space:]]'),
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    max_players INTEGER NOT NULL CHECK (max_players BETWEEN 1 AND 250),
    current_players INTEGER NOT NULL DEFAULT 0
        CHECK (current_players >= 0 AND current_players <= max_players),
    protocol_version TEXT NOT NULL DEFAULT 'ridge-0.6'
        CHECK (protocol_version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$'),
    status TEXT NOT NULL DEFAULT 'ready'
        CHECK (status IN ('ready', 'draining', 'offline')),
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS ix_dedicated_servers_region_status_heartbeat
    ON ridge.dedicated_servers(region, status, last_heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS ridge.player_sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id TEXT NOT NULL
        CHECK (player_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
    server_id TEXT NOT NULL
        REFERENCES ridge.dedicated_servers(server_id) ON DELETE RESTRICT,
    status TEXT NOT NULL
        CHECK (status IN ('allocated', 'connected', 'released', 'expired')),
    lease_expires_at TIMESTAMPTZ,
    connected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((status = 'allocated' AND lease_expires_at IS NOT NULL) OR status <> 'allocated'),
    CHECK ((status = 'connected' AND connected_at IS NOT NULL) OR status <> 'connected')
);

-- A player can hold at most one live allocation/connection across all shards.
CREATE UNIQUE INDEX IF NOT EXISTS uq_player_sessions_one_active_player
    ON ridge.player_sessions(player_id)
    WHERE status IN ('allocated', 'connected');

CREATE INDEX IF NOT EXISTS ix_player_sessions_server_status_lease
    ON ridge.player_sessions(server_id, status, lease_expires_at);

CREATE INDEX IF NOT EXISTS ix_player_sessions_player_created
    ON ridge.player_sessions(player_id, created_at DESC);

COMMENT ON TABLE ridge.dedicated_servers IS
    'Registered RIDGE Dedicated Server instances, heartbeat freshness, region and advertised capacity.';
COMMENT ON TABLE ridge.player_sessions IS
    'Server-authoritative player session reservations and short leases; no wallet or gameplay state is stored here.';
COMMENT ON INDEX ridge.uq_player_sessions_one_active_player IS
    'Prevents simultaneous active sessions for one player across multiple RIDGE shards.';
