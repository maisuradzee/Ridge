import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { RidgeError } from './game-service.mjs';

export class RidgePostgresError extends RidgeError {
  constructor(status, code, message) {
    super(status, code, message);
    this.name = 'RidgePostgresError';
  }
}

const DEFAULT_JOB_ID = 'delivery_intro';
const DEFAULT_SERVER_ID = 'ridge-development-server';

export function hashCompletionProof(proof) {
  return createHash('sha256').update(String(proof ?? ''), 'utf8').digest('hex');
}

export function constantTimeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) {
    return false;
  }
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isObservedPositionInsideCheckpoint(checkpoint, position) {
  if (!checkpoint || !position) return false;
  const values = [position.x, position.y, position.z];
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) return false;
  if (values.some((value) => Math.abs(value) > 500)) return false;
  const dx = values[0] - Number(checkpoint.local_x_m);
  const dy = values[1] - Number(checkpoint.local_y_m);
  const dz = values[2] - Number(checkpoint.local_z_m);
  return Math.hypot(dx, dy, dz) <= Number(checkpoint.radius_m);
}

function displayNameFrom(playerRef) {
  const cleaned = String(playerRef).replace(/[^\p{L}\p{N} _.-]/gu, '').trim();
  return (cleaned || 'RIDGE მოთამაშე').slice(0, 48);
}

function toMinor(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('Database money value exceeded safe integer range.');
  return parsed;
}

function moneyString(minor) {
  return (minor / 100).toFixed(2);
}

async function inTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

async function ensurePlayerAndWallet(client, playerRef) {
  if (typeof playerRef !== 'string' || !playerRef.trim() || playerRef.length > 80) {
    throw new RidgePostgresError(400, 'INVALID_PLAYER_ID', 'მოთამაშის იდენტიფიკატორი არასწორია.');
  }

  const playerResult = await client.query(
    `INSERT INTO ridge.players (auth_subject, display_name)
     VALUES ($1, $2)
     ON CONFLICT (auth_subject) DO UPDATE SET updated_at = now()
     RETURNING id, auth_subject, display_name, created_at`,
    [playerRef, displayNameFrom(playerRef)],
  );
  const player = playerResult.rows[0];

  await client.query(
    `INSERT INTO ridge.ledger_accounts (account_type, owner_player_id, account_name, currency)
     VALUES ('personal_wallet', $1, $2, 'GEL')
     ON CONFLICT (owner_player_id) WHERE account_type = 'personal_wallet' DO NOTHING`,
    [player.id, `wallet:${playerRef}`],
  );
  const walletResult = await client.query(
    `SELECT id FROM ridge.ledger_accounts
      WHERE account_type = 'personal_wallet' AND owner_player_id = $1`,
    [player.id],
  );
  if (!walletResult.rows[0]) throw new Error('Player wallet could not be created.');
  return { ...player, walletAccountId: walletResult.rows[0].id };
}

async function getTreasuryAccount(client, lock = false) {
  const result = await client.query(
    `SELECT id FROM ridge.ledger_accounts
      WHERE account_type = 'system' AND account_name = 'RIDGE Job Reward Pool'
      ${lock ? 'FOR UPDATE' : ''}`,
  );
  if (!result.rows[0]) {
    throw new RidgePostgresError(503, 'TREASURY_NOT_INITIALIZED', 'სისტემური საპრიზო ანგარიში ჯერ არ არის ინიციალიზებული.');
  }
  return result.rows[0].id;
}

function publicCheckpoint(row) {
  return { id: row.checkpoint_key, title: row.title, sequence: Number(row.sequence_no) };
}

export async function createPostgresGameService({ pool, dedicatedServerId = DEFAULT_SERVER_ID, clock = () => Date.now() }) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A configured node-postgres Pool is required.');
  }

  await pool.query('SELECT 1');
  const schemaCheck = await pool.query(
    `SELECT to_regclass('ridge.players') AS players,
            to_regclass('ridge.player_jobs') AS player_jobs,
            to_regclass('ridge.job_checkpoint_definitions') AS checkpoint_definitions,
            to_regclass('ridge.ledger_entries') AS ledger_entries`,
  );
  const schema = schemaCheck.rows[0];
  if (!schema?.players || !schema?.player_jobs || !schema?.checkpoint_definitions || !schema?.ledger_entries) {
    throw new Error('RIDGE database migrations 001, 002 and 003 must be applied before starting PostgreSQL storage.');
  }

  await pool.query(
    `INSERT INTO ridge.world_state (state_key, state_value)
     VALUES ('world_epoch_ms', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
     ON CONFLICT (state_key) DO NOTHING`,
  );
  const epochResult = await pool.query(
    `SELECT (state_value #>> '{}')::bigint AS epoch_ms
       FROM ridge.world_state WHERE state_key = 'world_epoch_ms'`,
  );
  const worldEpochMs = Number(epochResult.rows[0]?.epoch_ms);
  if (!Number.isSafeInteger(worldEpochMs)) throw new Error('Persistent RIDGE world epoch is invalid.');
  const treasuryCheck = await pool.query(
    `SELECT count(*)::integer AS account_count
       FROM ridge.ledger_accounts
      WHERE account_type = 'system'
        AND account_name IN ('RIDGE Job Reward Pool', 'RIDGE Virtual Issuance')`,
  );
  if (Number(treasuryCheck.rows[0]?.account_count) !== 2) {
    throw new Error('RIDGE migration 003 must initialize both system ledger accounts.');
  }

  async function healthCheck() {
    await pool.query('SELECT 1');
    return true;
  }

  async function getPlayer(playerRef) {
    return inTransaction(pool, async (client) => {
      const player = await ensurePlayerAndWallet(client, playerRef);
      return {
        id: player.auth_subject,
        displayName: player.display_name,
        createdAt: new Date(player.created_at).toISOString(),
      };
    });
  }

  async function getWallet(playerRef) {
    return inTransaction(pool, async (client) => {
      const player = await ensurePlayerAndWallet(client, playerRef);
      const result = await client.query(
        `SELECT COALESCE(sum(le.amount_minor), 0)::text AS balance_minor,
                count(le.id)::integer AS ledger_entry_count
           FROM ridge.ledger_entries le
          WHERE le.account_id = $1`,
        [player.walletAccountId],
      );
      const balanceMinor = toMinor(result.rows[0].balance_minor);
      return {
        playerId: playerRef,
        currency: 'GEL',
        balanceMinor,
        balance: moneyString(balanceMinor),
        ledgerEntryCount: Number(result.rows[0].ledger_entry_count),
      };
    });
  }

  async function acceptJob(playerRef, definitionId = DEFAULT_JOB_ID) {
    return inTransaction(pool, async (client) => {
      const player = await ensurePlayerAndWallet(client, playerRef);
      // Serialize job acceptance per player in addition to the partial unique index.
      await client.query('SELECT id FROM ridge.players WHERE id = $1 FOR UPDATE', [player.id]);
      const definitionResult = await client.query(
        `SELECT id, title, description, reward_minor::text, min_duration_ms
           FROM ridge.job_definitions WHERE id = $1 AND is_active = TRUE`,
        [definitionId],
      );
      const definition = definitionResult.rows[0];
      if (!definition) throw new RidgePostgresError(404, 'JOB_NOT_FOUND', 'მითითებული სამუშაო ვერ მოიძებნა.');

      const activeResult = await client.query(
        `SELECT id FROM ridge.player_jobs WHERE player_id = $1 AND status = 'accepted' LIMIT 1`,
        [player.id],
      );
      if (activeResult.rows.length) throw new RidgePostgresError(409, 'ACTIVE_JOB_EXISTS', 'ჯერ დაასრულე ან გააუქმე მიმდინარე სამუშაო.');

      const checkpointsResult = await client.query(
        `SELECT checkpoint_key, title, sequence_no
           FROM ridge.job_checkpoint_definitions
          WHERE job_definition_id = $1 AND is_active = TRUE
          ORDER BY sequence_no`,
        [definition.id],
      );
      if (!checkpointsResult.rows.length) throw new RidgePostgresError(503, 'JOB_NOT_CONFIGURED', 'სამუშაოს საკონტროლო წერტილები კონფიგურირებული არ არის.');

      const completionProof = randomBytes(32).toString('base64url');
      const insertResult = await client.query(
        `INSERT INTO ridge.player_jobs (player_id, job_definition_id, status, completion_proof_hash)
         VALUES ($1, $2, 'accepted', $3)
         RETURNING id, accepted_at`,
        [player.id, definition.id, hashCompletionProof(completionProof)],
      );
      const job = insertResult.rows[0];
      return {
        id: job.id,
        definitionId: definition.id,
        title: definition.title,
        description: definition.description,
        status: 'accepted',
        acceptedAt: new Date(job.accepted_at).toISOString(),
        completionProof,
        reward: moneyString(toMinor(definition.reward_minor)),
        currency: 'GEL',
        minimumDurationMs: Number(definition.min_duration_ms),
        requiredCheckpoints: checkpointsResult.rows.map(publicCheckpoint),
        completedCheckpoints: [],
      };
    }).catch((error) => {
      if (error?.code === '23505') throw new RidgePostgresError(409, 'ACTIVE_JOB_EXISTS', 'ჯერ დაასრულე ან გააუქმე მიმდინარე სამუშაო.');
      throw error;
    });
  }

  async function getJob(playerRef, jobId) {
    const jobResult = await pool.query(
      `SELECT pj.id, pj.status, pj.accepted_at, pj.completed_at,
              jd.id AS definition_id, jd.reward_minor::text
         FROM ridge.player_jobs pj
         JOIN ridge.players p ON p.id = pj.player_id
         JOIN ridge.job_definitions jd ON jd.id = pj.job_definition_id
        WHERE p.auth_subject = $1 AND pj.id = $2`,
      [playerRef, jobId],
    );
    const job = jobResult.rows[0];
    if (!job) throw new RidgePostgresError(404, 'JOB_NOT_FOUND', 'სამუშაო ვერ მოიძებნა ამ მოთამაშისთვის.');
    const checkpointResult = await pool.query(
      `SELECT jcd.checkpoint_key, jcd.title, jcd.sequence_no, pjce.server_recorded_at
         FROM ridge.job_checkpoint_definitions jcd
         LEFT JOIN ridge.player_job_checkpoint_events pjce
           ON pjce.checkpoint_definition_id = jcd.id
          AND pjce.player_job_id = $2
        WHERE jcd.job_definition_id = $1
        ORDER BY jcd.sequence_no`,
      [job.definition_id, job.id],
    );
    const requiredCheckpoints = checkpointResult.rows.map(publicCheckpoint);
    const completedCheckpoints = checkpointResult.rows
      .filter((row) => row.server_recorded_at)
      .map((row) => ({ ...publicCheckpoint(row), recordedAt: new Date(row.server_recorded_at).toISOString() }));
    return {
      id: job.id,
      definitionId: job.definition_id,
      status: job.status,
      acceptedAt: new Date(job.accepted_at).toISOString(),
      completedAt: job.completed_at ? new Date(job.completed_at).toISOString() : null,
      requiredCheckpoints,
      completedCheckpoints,
      reward: moneyString(toMinor(job.reward_minor)),
      currency: 'GEL',
    };
  }

  async function recordJobCheckpoint(playerRef, jobId, checkpointId, serverEventId, observedPosition) {
    if (typeof serverEventId !== 'string' || !/^[A-Za-z0-9._:-]{12,120}$/.test(serverEventId)) {
      throw new RidgePostgresError(400, 'INVALID_SERVER_EVENT_ID', 'სერვერული მოვლენის იდენტიფიკატორი არასწორია.');
    }
    return inTransaction(pool, async (client) => {
      // A checkpoint event ID is globally unique across jobs. Serialize the
      // check-then-insert path so concurrent requests for different jobs cannot
      // both observe an unused ID and race into a generic unique-constraint error.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [serverEventId],
      );
      const jobResult = await client.query(
        `SELECT pj.id, pj.status, pj.job_definition_id, p.id AS player_id
           FROM ridge.player_jobs pj
           JOIN ridge.players p ON p.id = pj.player_id
          WHERE p.auth_subject = $1 AND pj.id = $2
          FOR UPDATE OF pj`,
        [playerRef, jobId],
      );
      const job = jobResult.rows[0];
      if (!job) throw new RidgePostgresError(404, 'JOB_NOT_FOUND', 'სამუშაო ვერ მოიძებნა ამ მოთამაშისთვის.');
      if (job.status !== 'accepted') throw new RidgePostgresError(409, 'JOB_NOT_ACTIVE', 'სამუშაო აღარ არის აქტიურ მდგომარეობაში.');

      const priorEvent = await client.query(
        `SELECT e.player_job_id, e.checkpoint_definition_id, d.checkpoint_key,
                e.observed_x_m, e.observed_y_m, e.observed_z_m
           FROM ridge.player_job_checkpoint_events e
           JOIN ridge.job_checkpoint_definitions d ON d.id = e.checkpoint_definition_id
          WHERE e.server_event_id = $1`,
        [serverEventId],
      );
      if (priorEvent.rows[0]) {
        const prior = priorEvent.rows[0];
        const samePosition = observedPosition
          && [observedPosition.x, observedPosition.y, observedPosition.z].every((value) => typeof value === 'number' && Number.isFinite(value))
          && Math.abs(Number(prior.observed_x_m) - observedPosition.x) <= 1e-6
          && Math.abs(Number(prior.observed_y_m) - observedPosition.y) <= 1e-6
          && Math.abs(Number(prior.observed_z_m) - observedPosition.z) <= 1e-6;
        if (prior.player_job_id !== job.id || prior.checkpoint_key !== checkpointId || !samePosition) {
          throw new RidgePostgresError(409, 'SERVER_EVENT_REUSED', 'სერვერული მოვლენის ID უკვე სხვა მონაცემებით გამოიყენება.');
        }
        const status = await client.query(
          `SELECT count(*)::integer AS completed_count FROM ridge.player_job_checkpoint_events WHERE player_job_id = $1`,
          [job.id],
        );
        const required = await client.query(
          `SELECT count(*)::integer AS required_count FROM ridge.job_checkpoint_definitions WHERE job_definition_id = $1 AND is_active`,
          [job.job_definition_id],
        );
        return { jobId, checkpointId: priorEvent.rows[0].checkpoint_key, recorded: true, replayed: true, completedCount: Number(status.rows[0].completed_count), requiredCount: Number(required.rows[0].required_count) };
      }

      const progress = await client.query(
        `SELECT count(*)::integer AS completed_count FROM ridge.player_job_checkpoint_events WHERE player_job_id = $1`,
        [job.id],
      );
      const completedCount = Number(progress.rows[0].completed_count);
      const definitions = await client.query(
        `SELECT id, checkpoint_key, title, sequence_no, local_x_m, local_y_m, local_z_m, radius_m
           FROM ridge.job_checkpoint_definitions
          WHERE job_definition_id = $1 AND is_active = TRUE
          ORDER BY sequence_no`,
        [job.job_definition_id],
      );
      const requiredCount = definitions.rows.length;
      const already = await client.query(
        `SELECT 1 FROM ridge.player_job_checkpoint_events
          WHERE player_job_id = $1 AND checkpoint_definition_id = (SELECT id FROM ridge.job_checkpoint_definitions WHERE job_definition_id = $2 AND checkpoint_key = $3)`,
        [job.id, job.job_definition_id, checkpointId],
      );
      if (already.rows.length) return { jobId, checkpointId, recorded: true, replayed: true, completedCount, requiredCount };
      const next = definitions.rows[completedCount];
      if (!next) throw new RidgePostgresError(409, 'ALL_CHECKPOINTS_COMPLETED', 'სამუშაოს ყველა საკონტროლო წერტილი უკვე გავლილია.');
      if (next.checkpoint_key !== checkpointId) throw new RidgePostgresError(409, 'CHECKPOINT_OUT_OF_ORDER', `შემდეგი საკონტროლო წერტილია: ${next.title}.`);
      if (!isObservedPositionInsideCheckpoint(next, observedPosition)) {
        throw new RidgePostgresError(422, 'CHECKPOINT_POSITION_INVALID', 'მოთამაშე საკონტროლო წერტილის დასაშვებ რადიუსში არ იმყოფება.');
      }

      const inserted = await client.query(
        `INSERT INTO ridge.player_job_checkpoint_events (
            player_job_id, checkpoint_definition_id, server_event_id,
            dedicated_server_id, observed_x_m, observed_y_m, observed_z_m, server_recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
         RETURNING server_recorded_at`,
        [job.id, next.id, serverEventId, dedicatedServerId,
          Number(observedPosition.x), Number(observedPosition.y), Number(observedPosition.z)],
      );
      return {
        jobId,
        checkpointId,
        recorded: true,
        replayed: false,
        completedCount: completedCount + 1,
        requiredCount,
        recordedAt: new Date(inserted.rows[0].server_recorded_at).toISOString(),
      };
    }).catch((error) => {
      if (error?.code === '23505') throw new RidgePostgresError(409, 'CHECKPOINT_ALREADY_RECORDED', 'ეს საკონტროლო წერტილი უკვე დაფიქსირებულია.');
      if (error?.code === '23514') throw new RidgePostgresError(409, 'CHECKPOINT_VALIDATION_FAILED', 'სერვერმა საკონტროლო წერტილის თანმიმდევრობა ან სტატუსი ვერ დაადასტურა.');
      throw error;
    });
  }

  async function completeJob(playerRef, jobId, proof) {
    return inTransaction(pool, async (client) => {
      const player = await ensurePlayerAndWallet(client, playerRef);
      const jobResult = await client.query(
        `SELECT pj.id, pj.status, pj.accepted_at, pj.completion_proof_hash,
                pj.reward_transaction_id, jd.reward_minor::text, jd.min_duration_ms,
                (extract(epoch from (clock_timestamp() - pj.accepted_at)) * 1000)::bigint AS elapsed_ms,
                jd.id AS definition_id
           FROM ridge.player_jobs pj
           JOIN ridge.job_definitions jd ON jd.id = pj.job_definition_id
          WHERE pj.id = $1 AND pj.player_id = $2
          FOR UPDATE OF pj`,
        [jobId, player.id],
      );
      const job = jobResult.rows[0];
      if (!job) throw new RidgePostgresError(404, 'JOB_NOT_FOUND', 'სამუშაო ვერ მოიძებნა ამ მოთამაშისთვის.');
      if (!constantTimeHexEqual(job.completion_proof_hash, hashCompletionProof(proof))) {
        throw new RidgePostgresError(403, 'INVALID_COMPLETION_PROOF', 'სამუშაოს დასრულების დამადასტურებელი კოდი არასწორია.');
      }

      if (job.status === 'completed' && job.reward_transaction_id) {
        const balanceResult = await client.query(
          `SELECT COALESCE(sum(amount_minor), 0)::text AS balance_minor FROM ridge.ledger_entries WHERE account_id = $1`,
          [player.walletAccountId],
        );
        return {
          jobId: job.id,
          status: 'completed',
          reward: moneyString(toMinor(job.reward_minor)),
          currency: 'GEL',
          balance: moneyString(toMinor(balanceResult.rows[0].balance_minor)),
          transactionId: job.reward_transaction_id,
          replayed: true,
        };
      }
      if (job.status !== 'accepted') throw new RidgePostgresError(409, 'JOB_NOT_ACTIVE', 'სამუშაო აღარ არის აქტიურ მდგომარეობაში.');
      if (Number(job.elapsed_ms) < Number(job.min_duration_ms)) {
        throw new RidgePostgresError(422, 'JOB_COMPLETED_TOO_SOON', 'სამუშაოს შესრულებისთვის საკმარისი დრო არ გასულა.');
      }

      const checkpointCounts = await client.query(
        `SELECT
            (SELECT count(*) FROM ridge.job_checkpoint_definitions WHERE job_definition_id = $2 AND is_active)::integer AS required_count,
            (SELECT count(*) FROM ridge.player_job_checkpoint_events WHERE player_job_id = $1)::integer AS completed_count`,
        [job.id, job.definition_id],
      );
      const { required_count: requiredCount, completed_count: completedCount } = checkpointCounts.rows[0];
      if (Number(requiredCount) === 0 || Number(completedCount) !== Number(requiredCount)) {
        throw new RidgePostgresError(409, 'JOB_CHECKPOINTS_INCOMPLETE', 'სამუშაოს დასრულებამდე ყველა საკონტროლო წერტილი უნდა გაიარო.');
      }

      const treasuryAccountId = await getTreasuryAccount(client, true);
      const rewardMinor = toMinor(job.reward_minor);
      const treasuryBalanceResult = await client.query(
        `SELECT COALESCE(sum(amount_minor), 0)::text AS balance_minor
           FROM ridge.ledger_entries WHERE account_id = $1`,
        [treasuryAccountId],
      );
      if (toMinor(treasuryBalanceResult.rows[0].balance_minor) < rewardMinor) {
        throw new RidgePostgresError(503, 'REWARD_POOL_EMPTY', 'სისტემური საპრიზო ანგარიში დროებით მიუწვდომელია.');
      }

      const idempotencyKey = `job-reward:${job.id}`;
      const transactionResult = await client.query(
        `INSERT INTO ridge.ledger_transactions (
            idempotency_key, transaction_type, status, initiated_by, reason, metadata
         ) VALUES ($1, 'job_reward', 'pending', $2, 'კურიერის სამუშაოს შესრულების ჯილდო', $3::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [idempotencyKey, player.id, JSON.stringify({ jobId: job.id, definitionId: job.definition_id })],
      );
      if (!transactionResult.rows[0]) {
        throw new RidgePostgresError(409, 'REWARD_TRANSACTION_EXISTS', 'ამ სამუშაოს ჯილდოს ტრანზაქცია უკვე არსებობს; საჭიროა აუდიტის შემოწმება.');
      }
      const transactionId = transactionResult.rows[0].id;
      await client.query(
        `INSERT INTO ridge.ledger_entries (transaction_id, account_id, amount_minor)
         VALUES ($1, $2, $3), ($1, $4, $5)`,
        [transactionId, player.walletAccountId, rewardMinor, treasuryAccountId, -rewardMinor],
      );
      await client.query(
        `UPDATE ridge.ledger_transactions SET status = 'posted', posted_at = clock_timestamp() WHERE id = $1`,
        [transactionId],
      );
      await client.query(
        `UPDATE ridge.player_jobs
            SET status = 'completed', completed_at = clock_timestamp(), reward_transaction_id = $2
          WHERE id = $1`,
        [job.id, transactionId],
      );
      await client.query(
        `INSERT INTO ridge.audit_logs (actor_player_id, actor_type, action, target_type, target_id, reason, metadata)
         VALUES ($1, 'service', 'job.completed', 'player_job', $2, 'Reward transaction posted', $3::jsonb)`,
        [player.id, job.id, JSON.stringify({ transactionId, rewardMinor })],
      );
      const balanceResult = await client.query(
        `SELECT COALESCE(sum(amount_minor), 0)::text AS balance_minor FROM ridge.ledger_entries WHERE account_id = $1`,
        [player.walletAccountId],
      );
      return {
        jobId: job.id,
        status: 'completed',
        reward: moneyString(rewardMinor),
        currency: 'GEL',
        balance: moneyString(toMinor(balanceResult.rows[0].balance_minor)),
        transactionId,
        replayed: false,
      };
    });
  }

  async function getWorldState() {
    const now = clock();
    const elapsedRealSeconds = Math.max(0, Math.floor((now - worldEpochMs) / 1000));
    const gameSeconds = ((8 * 60 * 60) + (elapsedRealSeconds * 6)) % 86400;
    const hours = Math.floor(gameSeconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((gameSeconds % 3600) / 60).toString().padStart(2, '0');
    return {
      worldId: 'ridge-saburtalo-world',
      region: 'თბილისი',
      district: 'საბურთალო',
      worldTime: `${hours}:${minutes}`,
      timeScale: 6,
      mode: 'persistent-postgresql',
      serverTime: new Date(now).toISOString(),
    };
  }

  async function getLedger(playerRef) {
    const wallet = await getWallet(playerRef);
    const result = await pool.query(
      `SELECT le.transaction_id, le.account_id, le.amount_minor::text, le.created_at
         FROM ridge.ledger_entries le
         JOIN ridge.ledger_accounts la ON la.id = le.account_id
         JOIN ridge.players p ON p.id = la.owner_player_id
        WHERE p.auth_subject = $1 AND la.account_type = 'personal_wallet'
        ORDER BY le.created_at, le.id`,
      [playerRef],
    );
    return result.rows.map((row) => ({
      transactionId: row.transaction_id,
      amountMinor: toMinor(row.amount_minor),
      accountId: row.account_id,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async function getTransactionAudit(transactionId) {
    const result = await pool.query(
      `SELECT le.transaction_id, le.account_id, le.amount_minor::text
         FROM ridge.ledger_entries le WHERE le.transaction_id = $1 ORDER BY le.id`,
      [transactionId],
    );
    const entries = result.rows.map((row) => ({
      transactionId: row.transaction_id,
      accountId: row.account_id,
      amountMinor: toMinor(row.amount_minor),
    }));
    const totalMinor = entries.reduce((sum, entry) => sum + entry.amountMinor, 0);
    return { transactionId, entries, entryCount: entries.length, totalMinor, balanced: entries.length >= 2 && totalMinor === 0 };
  }

  return Object.freeze({
    storageMode: 'postgresql',
    healthCheck,
    getPlayer,
    getWallet,
    acceptJob,
    getJob,
    recordJobCheckpoint,
    completeJob,
    getWorldState,
    getLedger,
    getTransactionAudit,
    close: () => pool.end(),
  });
}