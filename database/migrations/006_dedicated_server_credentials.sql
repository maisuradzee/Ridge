-- RIDGE Stage 5: per-instance Dedicated Server credentials.
-- The provisioning/control-plane token is not stored here. Only SHA-256 digests
-- of individual server bearer credentials are persisted.
CREATE TABLE IF NOT EXISTS ridge.dedicated_server_credentials (
    server_id TEXT PRIMARY KEY
        CHECK (server_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
    credential_id UUID NOT NULL DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL
        CHECK (token_hash ~ '^[a-f0-9]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS ix_dedicated_server_credentials_expiry
    ON ridge.dedicated_server_credentials(expires_at)
    WHERE revoked_at IS NULL;

COMMENT ON TABLE ridge.dedicated_server_credentials IS
    'Per-process Dedicated Server bearer credentials; only a SHA-256 digest is stored and rotation replaces the prior credential.';
COMMENT ON COLUMN ridge.dedicated_server_credentials.token_hash IS
    'SHA-256 digest of a random 256-bit per-instance server token; plaintext token is returned only once.';
