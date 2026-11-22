import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export class RidgeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RidgeError';
    this.status = status;
    this.code = code;
  }
}

const JOB_DEFINITIONS = Object.freeze({
  delivery_intro: Object.freeze({
    id: 'delivery_intro',
    title: 'საცდელი მიწოდება',
    description: 'მიიღე ამანათი საწყობში და მიიტანე დანიშნულების ადგილზე.',
    rewardMinor: 1500,
    minimumDurationMs: 1500,
    checkpoints: Object.freeze([
      Object.freeze({ id: 'warehouse_pickup', title: 'საწყობიდან ამანათის აღება', sequence: 1 }),
      Object.freeze({ id: 'delivery_dropoff', title: 'ამანათის ჩაბარება', sequence: 2 }),
    ]),
  }),
});

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * In-memory development service for the first API vertical slice.
 * Replace with a transactional PostgreSQL repository before production.
 */
export function createGameService({ clock = () => Date.now(), treasurySeedMinor = 100_000_000 } = {}) {
  const players = new Map();
  const jobs = new Map();
  const transactions = new Map();
  const checkpointEvents = new Map();
  const ledgerEntries = [];
  const treasuryAccountId = 'system:job-rewards';
  const worldEpochMs = clock();
  let treasuryBalanceMinor = treasurySeedMinor;

  function ensurePlayer(playerId, displayName = 'RIDGE მოთამაშე') {
    if (!playerId || typeof playerId !== 'string' || playerId.length > 80) {
      throw new RidgeError(400, 'INVALID_PLAYER_ID', 'მოთამაშის იდენტიფიკატორი არასწორია.');
    }
    if (!players.has(playerId)) {
      players.set(playerId, {
        id: playerId,
        displayName,
        walletAccountId: `wallet:${playerId}`,
        balanceMinor: 0,
        createdAt: new Date(clock()).toISOString(),
      });
    }
    return players.get(playerId);
  }

  function getPlayer(playerId) {
    const player = ensurePlayer(playerId);
    return {
      id: player.id,
      displayName: player.displayName,
      createdAt: player.createdAt,
    };
  }

  function getWallet(playerId) {
    const player = ensurePlayer(playerId);
    return {
      playerId,
      currency: 'GEL',
      balanceMinor: player.balanceMinor,
      balance: (player.balanceMinor / 100).toFixed(2),
      ledgerEntryCount: ledgerEntries.filter((entry) => entry.accountId === player.walletAccountId).length,
    };
  }

  function acceptJob(playerId, definitionId = 'delivery_intro') {
    const player = ensurePlayer(playerId);
    const definition = JOB_DEFINITIONS[definitionId];
    if (!definition) {
      throw new RidgeError(404, 'JOB_NOT_FOUND', 'მითითებული სამუშაო ვერ მოიძებნა.');
    }

    const existingActive = [...jobs.values()].find((job) => job.playerId === playerId && job.status === 'accepted');
    if (existingActive) {
      throw new RidgeError(409, 'ACTIVE_JOB_EXISTS', 'ჯერ დაასრულე ან გააუქმე მიმდინარე სამუშაო.');
    }

    const jobId = randomUUID();
    const proof = randomBytes(24).toString('base64url');
    const acceptedAtMs = clock();
    const job = {
      id: jobId,
      definitionId: definition.id,
      playerId,
      status: 'accepted',
      acceptedAtMs,
      acceptedAt: new Date(acceptedAtMs).toISOString(),
      proof,
      completedAt: null,
      rewardMinor: definition.rewardMinor,
      requiredCheckpoints: definition.checkpoints.map((checkpoint) => ({ ...checkpoint })),
      completedCheckpoints: [],
      checkpointEventIds: new Set(),
      transactionId: null,
    };
    jobs.set(jobId, job);

    return {
      id: job.id,
      definitionId: definition.id,
      title: definition.title,
      description: definition.description,
      status: job.status,
      acceptedAt: job.acceptedAt,
      completionProof: proof,
      reward: (definition.rewardMinor / 100).toFixed(2),
      currency: 'GEL',
      minimumDurationMs: definition.minimumDurationMs,
      requiredCheckpoints: definition.checkpoints.map(({ id, title, sequence }) => ({ id, title, sequence })),
      completedCheckpoints: [],
    };
  }

  function getJob(playerId, jobId) {
    const job = jobs.get(jobId);
    if (!job || job.playerId !== playerId) {
      throw new RidgeError(404, 'JOB_NOT_FOUND', 'სამუშაო ვერ მოიძებნა ამ მოთამაშისთვის.');
    }
    return {
      id: job.id,
      definitionId: job.definitionId,
      status: job.status,
      acceptedAt: job.acceptedAt,
      completedAt: job.completedAt,
      requiredCheckpoints: job.requiredCheckpoints.map(({ id, title, sequence }) => ({ id, title, sequence })),
      completedCheckpoints: job.completedCheckpoints.map(({ id, title, sequence, recordedAt }) => ({ id, title, sequence, recordedAt })),
      reward: (job.rewardMinor / 100).toFixed(2),
      currency: 'GEL',
    };
  }

  /**
   * Records a checkpoint event already validated by the trusted dedicated game server.
   * Never expose this operation directly to an untrusted game client.
   */
  function recordJobCheckpoint(playerId, jobId, checkpointId, serverEventId) {
    const job = jobs.get(jobId);
    if (!job || job.playerId !== playerId) {
      throw new RidgeError(404, 'JOB_NOT_FOUND', 'სამუშაო ვერ მოიძებნა ამ მოთამაშისთვის.');
    }
    if (job.status !== 'accepted') {
      throw new RidgeError(409, 'JOB_NOT_ACTIVE', 'სამუშაო აღარ არის აქტიურ მდგომარეობაში.');
    }
    if (typeof serverEventId !== 'string' || !/^[A-Za-z0-9._:-]{12,120}$/.test(serverEventId)) {
      throw new RidgeError(400, 'INVALID_SERVER_EVENT_ID', 'სერვერული მოვლენის იდენტიფიკატორი არასწორია.');
    }

    const eventKey = `${jobId}:${serverEventId}`;
    const previousEvent = checkpointEvents.get(eventKey);
    if (previousEvent) {
      return { jobId, checkpointId: previousEvent.checkpointId, recorded: true, replayed: true, completedCount: job.completedCheckpoints.length, requiredCount: job.requiredCheckpoints.length };
    }

    const alreadyCompleted = job.completedCheckpoints.find((item) => item.id === checkpointId);
    if (alreadyCompleted) {
      checkpointEvents.set(eventKey, { jobId, checkpointId, serverEventId, recordedAt: new Date(clock()).toISOString() });
      return { jobId, checkpointId, recorded: true, replayed: true, completedCount: job.completedCheckpoints.length, requiredCount: job.requiredCheckpoints.length };
    }

    const nextCheckpoint = job.requiredCheckpoints[job.completedCheckpoints.length];
    if (!nextCheckpoint) {
      throw new RidgeError(409, 'ALL_CHECKPOINTS_COMPLETED', 'სამუშაოს ყველა საკონტროლო წერტილი უკვე გავლილია.');
    }
    if (checkpointId !== nextCheckpoint.id) {
      throw new RidgeError(409, 'CHECKPOINT_OUT_OF_ORDER', `შემდეგი საკონტროლო წერტილია: ${nextCheckpoint.title}.`);
    }

    const recordedAt = new Date(clock()).toISOString();
    const event = { jobId, checkpointId, serverEventId, recordedAt };
    checkpointEvents.set(eventKey, event);
    job.checkpointEventIds.add(serverEventId);
    job.completedCheckpoints.push({ ...nextCheckpoint, recordedAt });
    return { jobId, checkpointId, recorded: true, replayed: false, completedCount: job.completedCheckpoints.length, requiredCount: job.requiredCheckpoints.length };
  }

  function completeJob(playerId, jobId, proof) {
    const player = ensurePlayer(playerId);
    const job = jobs.get(jobId);
    if (!job || job.playerId !== playerId) {
      throw new RidgeError(404, 'JOB_NOT_FOUND', 'სამუშაო ვერ მოიძებნა ამ მოთამაშისთვის.');
    }
    if (!safeEqual(job.proof, proof)) {
      throw new RidgeError(403, 'INVALID_COMPLETION_PROOF', 'სამუშაოს დასრულების დამადასტურებელი კოდი არასწორია.');
    }

    const idempotencyKey = `job-reward:${job.id}`;
    const previousTransaction = transactions.get(idempotencyKey);
    if (job.status === 'completed' && previousTransaction) {
      return {
        jobId: job.id,
        status: 'completed',
        reward: (job.rewardMinor / 100).toFixed(2),
        currency: 'GEL',
        balance: (player.balanceMinor / 100).toFixed(2),
        transactionId: previousTransaction.id,
        replayed: true,
      };
    }
    if (job.status !== 'accepted') {
      throw new RidgeError(409, 'JOB_NOT_ACTIVE', 'სამუშაო აღარ არის აქტიურ მდგომარეობაში.');
    }

    const elapsedMs = clock() - job.acceptedAtMs;
    const definition = JOB_DEFINITIONS[job.definitionId];
    if (job.completedCheckpoints.length !== job.requiredCheckpoints.length) {
      throw new RidgeError(409, 'JOB_CHECKPOINTS_INCOMPLETE', 'სამუშაოს დასრულებამდე ყველა საკონტროლო წერტილი უნდა გაიარო.');
    }
    if (elapsedMs < definition.minimumDurationMs) {
      throw new RidgeError(422, 'JOB_COMPLETED_TOO_SOON', 'სამუშაოს შესრულებისთვის საკმარისი დრო არ გასულა.');
    }
    if (treasuryBalanceMinor < job.rewardMinor) {
      throw new RidgeError(503, 'REWARD_POOL_EMPTY', 'სისტემური საპრიზო ანგარიში დროებით მიუწვდომელია.');
    }

    // All mutations below are synchronous and atomic within this single-process prototype.
    // Production must perform the same operation in one PostgreSQL transaction.
    const transaction = {
      id: randomUUID(),
      idempotencyKey,
      type: 'job_reward',
      playerId,
      amountMinor: job.rewardMinor,
      createdAt: new Date(clock()).toISOString(),
    };
    transactions.set(idempotencyKey, transaction);
    ledgerEntries.push(
      { transactionId: transaction.id, accountId: player.walletAccountId, amountMinor: job.rewardMinor },
      { transactionId: transaction.id, accountId: treasuryAccountId, amountMinor: -job.rewardMinor },
    );
    player.balanceMinor += job.rewardMinor;
    treasuryBalanceMinor -= job.rewardMinor;
    job.status = 'completed';
    job.completedAt = transaction.createdAt;
    job.transactionId = transaction.id;

    return {
      jobId: job.id,
      status: 'completed',
      reward: (job.rewardMinor / 100).toFixed(2),
      currency: 'GEL',
      balance: (player.balanceMinor / 100).toFixed(2),
      transactionId: transaction.id,
      replayed: false,
    };
  }

  function getWorldState() {
    const now = clock();
    const elapsedRealSeconds = Math.max(0, Math.floor((now - worldEpochMs) / 1000));
    const gameSeconds = ((8 * 60 * 60) + (elapsedRealSeconds * 6)) % 86400;
    const hours = Math.floor(gameSeconds / 3600).toString().padStart(2, '0');
    const minutes = Math.floor((gameSeconds % 3600) / 60).toString().padStart(2, '0');
    return {
      worldId: 'ridge-dev-world',
      region: 'თბილისი',
      district: 'საბურთალო',
      worldTime: `${hours}:${minutes}`,
      timeScale: 6,
      mode: 'development-simulation',
      serverTime: new Date(now).toISOString(),
    };
  }

  function getLedger(playerId) {
    const player = ensurePlayer(playerId);
    return ledgerEntries
      .filter((entry) => entry.accountId === player.walletAccountId)
      .map((entry) => ({ ...entry }));
  }

  function getTransactionAudit(transactionId) {
    const entries = ledgerEntries
      .filter((entry) => entry.transactionId === transactionId)
      .map((entry) => ({ ...entry }));
    return {
      transactionId,
      entries,
      entryCount: entries.length,
      totalMinor: entries.reduce((sum, entry) => sum + entry.amountMinor, 0),
      balanced: entries.length >= 2 && entries.reduce((sum, entry) => sum + entry.amountMinor, 0) === 0,
    };
  }

  return Object.freeze({
    ensurePlayer,
    getPlayer,
    getWallet,
    acceptJob,
    getJob,
    recordJobCheckpoint,
    completeJob,
    getWorldState,
    getLedger,
    getTransactionAudit,
  });
}