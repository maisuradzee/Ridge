-- RIDGE Stage 5: append-only audit history for Dedicated Server credentials.
-- No plaintext bearer token or token digest is stored in this table.
-- Apply after migrations 001-006.

CREATE TABLE IF NOT EXISTS ridge.dedicated_server_credential_events (
    audit_sequence BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id TEXT NOT NULL
        CHECK (server_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
    credential_id UUID NOT NULL,
    previous_credential_id UUID,
    action TEXT NOT NULL
        CHECK (action IN ('issued', 'rotated', 'revoked')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (action = 'rotated' AND previous_credential_id IS NOT NULL)
        OR
        (action <> 'rotated' AND previous_credential_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS ix_dedicated_server_credential_events_history
    ON ridge.dedicated_server_credential_events(server_id, audit_sequence DESC);

CREATE OR REPLACE FUNCTION ridge.reject_server_credential_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'RIDGE server credential audit history is append-only'
        USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_server_credential_events_no_update
    ON ridge.dedicated_server_credential_events;
CREATE TRIGGER trg_server_credential_events_no_update
    BEFORE UPDATE OR DELETE ON ridge.dedicated_server_credential_events
    FOR EACH ROW
    EXECUTE FUNCTION ridge.reject_server_credential_event_mutation();

COMMENT ON TABLE ridge.dedicated_server_credential_events IS
    'Append-only history of Dedicated Server credential issuance, rotation and revocation; never stores bearer tokens or token digests.';
COMMENT ON COLUMN ridge.dedicated_server_credential_events.audit_sequence IS
    'Monotonic insertion order used for stable per-server audit pagination.';
COMMENT ON COLUMN ridge.dedicated_server_credential_events.previous_credential_id IS
    'The credential replaced by a rotation; null for issuance and revocation.';
