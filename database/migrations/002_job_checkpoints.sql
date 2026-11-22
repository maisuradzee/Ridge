-- RIDGE Stage 2: ordered server-verified job checkpoints.
-- Apply only after 001_initial_schema.sql in a dedicated development database.
-- Coordinates are provisional local blockout metres, NOT real-world GIS coordinates.

CREATE TABLE IF NOT EXISTS ridge.job_checkpoint_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_definition_id TEXT NOT NULL REFERENCES ridge.job_definitions(id) ON DELETE RESTRICT,
    checkpoint_key TEXT NOT NULL,
    sequence_no SMALLINT NOT NULL CHECK (sequence_no > 0),
    title TEXT NOT NULL,
    map_id TEXT NOT NULL DEFAULT 'saburtalo_blockout_v1',
    local_x_m DOUBLE PRECISION NOT NULL,
    local_y_m DOUBLE PRECISION NOT NULL,
    local_z_m DOUBLE PRECISION NOT NULL DEFAULT 0,
    radius_m DOUBLE PRECISION NOT NULL DEFAULT 5 CHECK (radius_m BETWEEN 1 AND 50),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_definition_id, checkpoint_key),
    UNIQUE (job_definition_id, sequence_no),
    UNIQUE (job_definition_id, id)
);

CREATE TABLE IF NOT EXISTS ridge.player_job_checkpoint_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_job_id UUID NOT NULL REFERENCES ridge.player_jobs(id) ON DELETE RESTRICT,
    checkpoint_definition_id UUID NOT NULL REFERENCES ridge.job_checkpoint_definitions(id) ON DELETE RESTRICT,
    server_event_id TEXT NOT NULL UNIQUE CHECK (char_length(server_event_id) BETWEEN 12 AND 120),
    dedicated_server_id TEXT NOT NULL CHECK (char_length(dedicated_server_id) BETWEEN 1 AND 100),
    observed_x_m DOUBLE PRECISION NOT NULL,
    observed_y_m DOUBLE PRECISION NOT NULL,
    observed_z_m DOUBLE PRECISION NOT NULL,
    server_recorded_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (player_job_id, checkpoint_definition_id),
    UNIQUE (player_job_id, server_event_id)
);

CREATE INDEX IF NOT EXISTS ix_job_checkpoint_events_job_created
    ON ridge.player_job_checkpoint_events(player_job_id, created_at);

CREATE OR REPLACE FUNCTION ridge.validate_job_checkpoint_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_job_definition_id TEXT;
    v_job_status TEXT;
    v_checkpoint_job_definition_id TEXT;
    v_checkpoint_sequence SMALLINT;
    v_next_sequence BIGINT;
BEGIN
    SELECT job_definition_id, status
      INTO v_job_definition_id, v_job_status
      FROM ridge.player_jobs
     WHERE id = NEW.player_job_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player job does not exist' USING ERRCODE = '23503';
    END IF;
    IF v_job_status <> 'accepted' THEN
        RAISE EXCEPTION 'Checkpoints can only be recorded for accepted jobs' USING ERRCODE = '23514';
    END IF;

    SELECT job_definition_id, sequence_no
      INTO v_checkpoint_job_definition_id, v_checkpoint_sequence
      FROM ridge.job_checkpoint_definitions
     WHERE id = NEW.checkpoint_definition_id
       AND is_active = TRUE;

    IF NOT FOUND OR v_checkpoint_job_definition_id <> v_job_definition_id THEN
        RAISE EXCEPTION 'Checkpoint does not belong to this job definition' USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(MAX(jcd.sequence_no), 0) + 1
      INTO v_next_sequence
      FROM ridge.player_job_checkpoint_events pjce
      JOIN ridge.job_checkpoint_definitions jcd
        ON jcd.id = pjce.checkpoint_definition_id
     WHERE pjce.player_job_id = NEW.player_job_id;

    IF v_checkpoint_sequence <> v_next_sequence THEN
        RAISE EXCEPTION 'Checkpoint sequence out of order; expected %, received %',
            v_next_sequence, v_checkpoint_sequence
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_job_checkpoint_event ON ridge.player_job_checkpoint_events;
CREATE TRIGGER trg_validate_job_checkpoint_event
BEFORE INSERT ON ridge.player_job_checkpoint_events
FOR EACH ROW
EXECUTE FUNCTION ridge.validate_job_checkpoint_event();

CREATE OR REPLACE FUNCTION ridge.prevent_job_checkpoint_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Checkpoint events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS trg_job_checkpoint_events_immutable ON ridge.player_job_checkpoint_events;
CREATE TRIGGER trg_job_checkpoint_events_immutable
BEFORE UPDATE OR DELETE ON ridge.player_job_checkpoint_events
FOR EACH ROW
EXECUTE FUNCTION ridge.prevent_job_checkpoint_event_mutation();

CREATE OR REPLACE FUNCTION ridge.audit_job_checkpoint_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO ridge.audit_logs (
        actor_type, action, target_type, target_id, reason, metadata
    ) VALUES (
        'service',
        'job.checkpoint_recorded',
        'player_job',
        NEW.player_job_id::TEXT,
        'Checkpoint validated and submitted by trusted dedicated server',
        jsonb_build_object(
            'checkpoint_definition_id', NEW.checkpoint_definition_id,
            'server_event_id', NEW.server_event_id,
            'dedicated_server_id', NEW.dedicated_server_id,
            'map_position', jsonb_build_array(NEW.observed_x_m, NEW.observed_y_m, NEW.observed_z_m)
        )
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_job_checkpoint_event ON ridge.player_job_checkpoint_events;
CREATE TRIGGER trg_audit_job_checkpoint_event
AFTER INSERT ON ridge.player_job_checkpoint_events
FOR EACH ROW
EXECUTE FUNCTION ridge.audit_job_checkpoint_event();

INSERT INTO ridge.job_checkpoint_definitions (
    job_definition_id, checkpoint_key, sequence_no, title, map_id,
    local_x_m, local_y_m, local_z_m, radius_m
)
VALUES
    ('delivery_intro', 'warehouse_pickup', 1, 'საწყობიდან ამანათის აღება', 'saburtalo_blockout_v1', -280, 210, 0, 7),
    ('delivery_intro', 'delivery_dropoff', 2, 'ამანათის ჩაბარება', 'saburtalo_blockout_v1', 270, -180, 0, 6)
ON CONFLICT (job_definition_id, checkpoint_key) DO NOTHING;

COMMENT ON TABLE ridge.job_checkpoint_definitions IS
    'Configured checkpoint targets for missions; local coordinates are provisional blockout metres.';
COMMENT ON TABLE ridge.player_job_checkpoint_events IS
    'Append-only proof records written by trusted dedicated game servers, never directly by clients.';