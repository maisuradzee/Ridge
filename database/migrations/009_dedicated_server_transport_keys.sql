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

COMMENT ON TABLE ridge.dedicated_server_transport_keys IS
    'Stores only authenticated X25519 public keys; private key material remains in the Dedicated Server process.';
COMMENT ON COLUMN ridge.dedicated_server_transport_keys.public_key IS
    'Canonical unpadded base64url encoding of exactly 32 raw X25519 public-key bytes.';
COMMENT ON COLUMN ridge.dedicated_server_transport_keys.expires_at IS
    'Public key validity bound; Gateway must not issue tickets that outlive this key.';
