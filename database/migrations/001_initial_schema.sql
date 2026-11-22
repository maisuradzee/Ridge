-- RIDGE initial PostgreSQL schema
-- This migration is a foundation and is NOT applied to any remote database.
-- All game clients must access this schema through trusted backend services.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS ridge;

CREATE TABLE IF NOT EXISTS ridge.players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_subject TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 48),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ridge.ledger_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_type TEXT NOT NULL CHECK (account_type IN ('personal_wallet', 'business', 'organization', 'government', 'system')),
    owner_player_id UUID REFERENCES ridge.players(id) ON DELETE RESTRICT,
    account_name TEXT NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'GEL' CHECK (currency = 'GEL'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (account_type = 'personal_wallet' AND owner_player_id IS NOT NULL)
        OR (account_type <> 'personal_wallet')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_personal_wallet
    ON ridge.ledger_accounts(owner_player_id)
    WHERE account_type = 'personal_wallet';

CREATE TABLE IF NOT EXISTS ridge.ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    transaction_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'reversed', 'rejected')),
    initiated_by UUID REFERENCES ridge.players(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    posted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ridge.ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES ridge.ledger_transactions(id) ON DELETE RESTRICT,
    account_id UUID NOT NULL REFERENCES ridge.ledger_accounts(id) ON DELETE RESTRICT,
    amount_minor BIGINT NOT NULL CHECK (amount_minor <> 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ledger_entries_account_created
    ON ridge.ledger_entries(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_ledger_entries_transaction
    ON ridge.ledger_entries(transaction_id);

CREATE OR REPLACE FUNCTION ridge.assert_ledger_transaction_balanced()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_transaction_id UUID;
    v_status TEXT;
    v_entry_count BIGINT;
    v_total BIGINT;
BEGIN
    v_transaction_id := NEW.id;
    SELECT status INTO v_status
    FROM ridge.ledger_transactions
    WHERE id = v_transaction_id;

    IF v_status = 'posted' THEN
        SELECT count(*), COALESCE(sum(amount_minor), 0)
          INTO v_entry_count, v_total
        FROM ridge.ledger_entries
        WHERE transaction_id = v_transaction_id;

        IF v_entry_count < 2 OR v_total <> 0 THEN
            RAISE EXCEPTION 'Ledger transaction % is not balanced', v_transaction_id
                USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_transaction_balanced ON ridge.ledger_transactions;
CREATE CONSTRAINT TRIGGER trg_ledger_transaction_balanced
AFTER INSERT OR UPDATE OF status ON ridge.ledger_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION ridge.assert_ledger_transaction_balanced();

CREATE OR REPLACE FUNCTION ridge.prevent_ledger_entry_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Ledger entries are append-only; create a reversal transaction instead'
        USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_entries_immutable ON ridge.ledger_entries;
CREATE TRIGGER trg_ledger_entries_immutable
BEFORE UPDATE OR DELETE ON ridge.ledger_entries
FOR EACH ROW
EXECUTE FUNCTION ridge.prevent_ledger_entry_mutation();

CREATE OR REPLACE VIEW ridge.account_balances AS
SELECT
    account_id,
    COALESCE(sum(amount_minor), 0)::BIGINT AS balance_minor
FROM ridge.ledger_entries
GROUP BY account_id;

CREATE TABLE IF NOT EXISTS ridge.job_definitions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    reward_minor BIGINT NOT NULL CHECK (reward_minor >= 0),
    min_duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (min_duration_ms >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ridge.player_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    player_id UUID NOT NULL REFERENCES ridge.players(id) ON DELETE RESTRICT,
    job_definition_id TEXT NOT NULL REFERENCES ridge.job_definitions(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'cancelled', 'expired')),
    completion_proof_hash TEXT,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    reward_transaction_id UUID REFERENCES ridge.ledger_transactions(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((status = 'completed' AND completed_at IS NOT NULL) OR status <> 'completed')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_player_one_active_job
    ON ridge.player_jobs(player_id)
    WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS ix_player_jobs_player_created
    ON ridge.player_jobs(player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ridge.world_state (
    state_key TEXT PRIMARY KEY,
    state_value JSONB NOT NULL,
    version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ridge.audit_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_player_id UUID REFERENCES ridge.players(id) ON DELETE RESTRICT,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('player', 'admin', 'system', 'service')),
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_logs_target_created
    ON ridge.audit_logs(target_type, target_id, created_at DESC);

INSERT INTO ridge.job_definitions (id, title, description, reward_minor, min_duration_ms)
VALUES (
    'delivery_intro',
    'საცდელი მიწოდება',
    'მიიღე ამანათი საწყობში და მიიტანე დანიშნულების ადგილზე.',
    1500,
    1500
)
ON CONFLICT (id) DO NOTHING;

-- Production hardening checklist:
-- 1. Create a dedicated backend database role; never expose it to game clients.
-- 2. Restrict schema/table permissions to the backend role only.
-- 3. Use a reviewed auth provider and bind auth_subject to verified identity claims.
-- 4. Post ledger transactions and their entries in one database transaction.
-- 5. Verify each posted transaction has at least two entries and sum(amount_minor)=0.
-- 6. Add RLS/grants only after the chosen auth architecture is finalized.