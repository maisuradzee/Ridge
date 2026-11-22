-- RIDGE operational health invariants. READ-ONLY queries only.
-- Run against a dedicated monitoring/read-only PostgreSQL role.

-- 1) Posted ledger transactions must have >=2 entries and sum to zero.
WITH posted AS (
    SELECT t.id, t.idempotency_key, COUNT(e.id) AS entry_count,
           COALESCE(SUM(e.amount_minor), 0)::BIGINT AS total_minor
    FROM ridge.ledger_transactions t
    LEFT JOIN ridge.ledger_entries e ON e.transaction_id = t.id
    WHERE t.status = 'posted'
    GROUP BY t.id, t.idempotency_key
)
SELECT 'unbalanced_posted_ledger_transaction' AS invariant, id::TEXT AS object_id,
       jsonb_build_object('idempotency_key', idempotency_key,
                          'entry_count', entry_count,
                          'total_minor', total_minor) AS details
FROM posted
WHERE entry_count < 2 OR total_minor <> 0;

-- 2) Completed jobs must reference a posted reward transaction.
SELECT 'completed_job_missing_posted_reward' AS invariant,
       j.id::TEXT AS object_id,
       jsonb_build_object('status', j.status,
                          'reward_transaction_id', j.reward_transaction_id,
                          'transaction_status', t.status) AS details
FROM ridge.player_jobs j
LEFT JOIN ridge.ledger_transactions t ON t.id = j.reward_transaction_id
WHERE j.status = 'completed'
  AND (j.reward_transaction_id IS NULL OR t.status IS DISTINCT FROM 'posted');

-- 3) World-state versions must stay positive (table CHECK should already enforce this).
SELECT 'invalid_world_state_version' AS invariant,
       state_key AS object_id,
       jsonb_build_object('version', version, 'updated_at', updated_at) AS details
FROM ridge.world_state
WHERE version <= 0;

-- Expected healthy result: zero rows from all three queries.
-- NEVER use automatic UPDATE/DELETE to "repair" financial/player state.
-- Correct accounting through a new audited reversal/correction transaction.