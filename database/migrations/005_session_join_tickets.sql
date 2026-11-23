-- RIDGE Stage 5: one-time, short-lived Dedicated Server join tickets.
-- Migration 004 creates player_sessions. Store only SHA-256 ticket hashes;
-- the raw bearer ticket is returned once to the trusted gateway.

ALTER TABLE ridge.player_sessions
    ADD COLUMN IF NOT EXISTS join_ticket_hash TEXT
        CHECK (join_ticket_hash IS NULL OR join_ticket_hash ~ '^[a-f0-9]{64}$'),
    ADD COLUMN IF NOT EXISTS join_ticket_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS join_attempt_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'ck_player_sessions_join_ticket_pair'
           AND conrelid = 'ridge.player_sessions'::regclass
    ) THEN
        ALTER TABLE ridge.player_sessions
            ADD CONSTRAINT ck_player_sessions_join_ticket_pair
            CHECK (
                (join_ticket_hash IS NULL AND join_ticket_expires_at IS NULL)
                OR (join_ticket_hash IS NOT NULL AND join_ticket_expires_at IS NOT NULL)
            );
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_sessions_join_ticket_hash
    ON ridge.player_sessions(join_ticket_hash)
    WHERE join_ticket_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_player_sessions_join_ticket_expiry
    ON ridge.player_sessions(join_ticket_expires_at)
    WHERE join_ticket_hash IS NOT NULL;

COMMENT ON COLUMN ridge.player_sessions.join_ticket_hash IS
    'SHA-256 digest of a random 256-bit bearer ticket; raw ticket is never stored.';
COMMENT ON COLUMN ridge.player_sessions.join_ticket_expires_at IS
    'Short expiry for the unconsumed join ticket, bounded by the parent session lease.';
COMMENT ON COLUMN ridge.player_sessions.join_attempt_id IS
    'Server-generated UUID used only to make a single asynchronous claim request idempotent.';
