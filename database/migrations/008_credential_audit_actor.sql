-- RIDGE Stage 5: trusted service-principal attribution for credential audit events.
-- Existing records are attributed to the legacy provisioner because older versions
-- did not record an actor. New API writes must supply the actor explicitly.

ALTER TABLE ridge.dedicated_server_credential_events
    ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'service';

ALTER TABLE ridge.dedicated_server_credential_events
    ADD COLUMN IF NOT EXISTS actor_id TEXT NOT NULL DEFAULT 'legacy-provisioner';

ALTER TABLE ridge.dedicated_server_credential_events
    ALTER COLUMN actor_type DROP DEFAULT;

ALTER TABLE ridge.dedicated_server_credential_events
    ALTER COLUMN actor_id DROP DEFAULT;

ALTER TABLE ridge.dedicated_server_credential_events
    DROP CONSTRAINT IF EXISTS ck_dedicated_server_credential_events_actor_type;

ALTER TABLE ridge.dedicated_server_credential_events
    ADD CONSTRAINT ck_dedicated_server_credential_events_actor_type
    CHECK (actor_type IN ('service', 'user', 'system'));

ALTER TABLE ridge.dedicated_server_credential_events
    DROP CONSTRAINT IF EXISTS ck_dedicated_server_credential_events_actor_id;

ALTER TABLE ridge.dedicated_server_credential_events
    ADD CONSTRAINT ck_dedicated_server_credential_events_actor_id
    CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$');

COMMENT ON COLUMN ridge.dedicated_server_credential_events.actor_type IS
    'Trusted server-side actor category. Current credential provisioning routes record service principals.';
COMMENT ON COLUMN ridge.dedicated_server_credential_events.actor_id IS
    'Stable service-principal identifier supplied from protected API configuration, never from request input.';
