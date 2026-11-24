-- RIDGE Stage 5: authenticated Dedicated Server X25519 public-key registry.
-- Only public keys are persisted. Ephemeral private keys must remain in the Dedicated Server process.

CREATE TABLE IF NOT EXISTS ridge.dedicated_server_transport_keys (
    server_id TEXT NOT NULL
        REFERENCES ridge.dedicated_servers(server_id) ON DELETE RESTRICT,
    key_id TEXT NOT NULL
        CHECK (key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
    algorithm TEXT NOT NULL DEFAULT 'X25519'
        CHECK (algorithm = 'X25519'),
    public_key TEXT NOT NULL
        CHECK (char_length(public_key) = 43)
        CHECK (public_key ~ '^[A-Za-z0-9_-]{43}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (server_id, key_id),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS ix_dedicated_server_transport_keys_current
    ON ridge.dedicated_server_transport_keys(server_id, created_at DESC, key_id DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS ridge.dedicated_server_transport_key_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('published', 'revoked')),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('dedicated_server', 'service')),
    actor_id TEXT NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (server_id, key_id)
        REFERENCES ridge.dedicated_server_transport_keys(server_id, key_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ix_dedicated_server_transport_key_events_audit
    ON ridge.dedicated_server_transport_key_events(server_id, occurred_at DESC, event_id DESC);

CREATE OR REPLACE FUNCTION ridge.reject_dedicated_server_transport_key_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'RIDGE transport key audit events are append-only'
        USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_transport_key_events_no_update ON ridge.dedicated_server_transport_key_events;
CREATE TRIGGER trg_transport_key_events_no_update
    BEFORE UPDATE OR DELETE ON ridge.dedicated_server_transport_key_events
    FOR EACH ROW
    EXECUTE FUNCTION ridge.reject_dedicated_server_transport_key_event_mutation();

COMMENT ON TABLE ridge.dedicated_server_transport_keys IS
    'Stores only authenticated X25519 public keys; private key material remains in the Dedicated Server process.';
COMMENT ON COLUMN ridge.dedicated_server_transport_keys.public_key IS
    'Canonical unpadded base64url encoding of exactly 32 raw X25519 public-key bytes.';
COMMENT ON COLUMN ridge.dedicated_server_transport_keys.expires_at IS
    'Public key validity bound; Gateway must not issue tickets that outlive this key.';
COMMENT ON TABLE ridge.dedicated_server_transport_key_events IS
    'Append-only audit of X25519 public-key publication and revocation; never stores private key material.';
