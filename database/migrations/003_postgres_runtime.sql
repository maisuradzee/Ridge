-- RIDGE v0.6.0: durable PostgreSQL runtime support.
-- Apply after 001_initial_schema.sql and 002_job_checkpoints.sql.
-- Run only against a dedicated development database on the first pass.

CREATE UNIQUE INDEX IF NOT EXISTS uq_system_account_name
    ON ridge.ledger_accounts(account_name)
    WHERE account_type = 'system';

ALTER TABLE ridge.player_jobs
    DROP CONSTRAINT IF EXISTS ck_completion_proof_hash_sha256;
ALTER TABLE ridge.player_jobs
    ADD CONSTRAINT ck_completion_proof_hash_sha256
    CHECK (completion_proof_hash IS NULL OR completion_proof_hash ~ '^[a-f0-9]{64}$');

-- Explicit system accounts: the reward pool is funded by a virtual issuance
-- account. This is in-game currency only; it has no real-world cash value.
INSERT INTO ridge.ledger_accounts (account_type, owner_player_id, account_name, currency)
VALUES
    ('system', NULL, 'RIDGE Job Reward Pool', 'GEL'),
    ('system', NULL, 'RIDGE Virtual Issuance', 'GEL')
ON CONFLICT (account_name) WHERE account_type = 'system' DO NOTHING;

-- Seed the introductory mission reward pool once. The double-entry posting is
-- balanced and protected by the unique idempotency key.
DO $$
DECLARE
    v_transaction_id UUID;
    v_reward_pool_id UUID;
    v_issuance_id UUID;
BEGIN
    SELECT id INTO STRICT v_reward_pool_id
      FROM ridge.ledger_accounts
     WHERE account_type = 'system' AND account_name = 'RIDGE Job Reward Pool';

    SELECT id INTO STRICT v_issuance_id
      FROM ridge.ledger_accounts
     WHERE account_type = 'system' AND account_name = 'RIDGE Virtual Issuance';

    INSERT INTO ridge.ledger_transactions (
        idempotency_key, transaction_type, status, reason, metadata
    ) VALUES (
        'system-opening:job-reward-pool:v1',
        'system_opening_balance',
        'pending',
        'საწყისი ვირტუალური საპრიზო ფონდი — განვითარების გარემო',
        jsonb_build_object('environment', 'development', 'currency', 'GEL', 'virtual_only', true)
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_transaction_id;

    IF v_transaction_id IS NOT NULL THEN
        INSERT INTO ridge.ledger_entries (transaction_id, account_id, amount_minor)
        VALUES
            (v_transaction_id, v_reward_pool_id, 100000000),
            (v_transaction_id, v_issuance_id, -100000000);

        UPDATE ridge.ledger_transactions
           SET status = 'posted', posted_at = clock_timestamp()
         WHERE id = v_transaction_id;
    END IF;
END;
$$;

-- Persist a single authoritative world epoch. Restarts do not reset game time.
INSERT INTO ridge.world_state (state_key, state_value)
VALUES (
    'world_epoch_ms',
    to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint)
)
ON CONFLICT (state_key) DO NOTHING;

CREATE INDEX IF NOT EXISTS ix_player_job_checkpoint_events_server_time
    ON ridge.player_job_checkpoint_events(dedicated_server_id, server_recorded_at DESC);

COMMENT ON INDEX ridge.uq_system_account_name IS
    'Ensures stable system account names for idempotent reward-pool initialization.';
COMMENT ON TABLE ridge.world_state IS
    'Persistent authoritative world state, including a world epoch that survives API restarts.';