import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgresGameService } from '../src/postgres-game-service.mjs';

const enabled = process.env.RIDGE_RUN_POSTGRES_INTEGRATION === 'YES';
const developmentOnly = process.env.RIDGE_DB_ENV === 'development';
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

function assertRidgeErrorCode(code) {
  return (error) => error?.code === code;
}

test('PostgreSQL integration: validates checkpoints, strict event idempotency, balanced one-time rewards and restart persistence', {
  skip: !enabled
    ? 'Set RIDGE_RUN_POSTGRES_INTEGRATION=YES to run against a dedicated development database.'
    : !developmentOnly
      ? 'Safety stop: RIDGE_DB_ENV must equal development.'
      : !hasDatabaseUrl
        ? 'DATABASE_URL is required.'
        : false,
}, async () => {
  assert.equal(developmentOnly, true, 'Integration test may run only against a development database.');
  const { Pool } = await import('pg');
  let pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  let service = null;

  try {
    service = await createPostgresGameService({
      pool,
      dedicatedServerId: 'ridge-postgres-integration-test',
    });

    const playerRef = `integration-${randomUUID()}`;
    const accepted = await service.acceptJob(playerRef, 'delivery_intro');
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.requiredCheckpoints.length, 2);

    const pickupEventId = `it-pickup-${randomUUID()}`;
    const pickupPosition = { x: -280, y: 210, z: 0 };
    const dropoffPosition = { x: 270, y: -180, z: 0 };

    await assert.rejects(
      service.recordJobCheckpoint(playerRef, accepted.id, 'delivery_dropoff', `it-order-${randomUUID()}`, dropoffPosition),
      assertRidgeErrorCode('CHECKPOINT_OUT_OF_ORDER'),
    );
    await assert.rejects(
      service.recordJobCheckpoint(playerRef, accepted.id, 'warehouse_pickup', `it-position-${randomUUID()}`, { x: -250, y: 210, z: 0 }),
      assertRidgeErrorCode('CHECKPOINT_POSITION_INVALID'),
    );

    const pickup = await service.recordJobCheckpoint(
      playerRef, accepted.id, 'warehouse_pickup', pickupEventId, pickupPosition,
    );
    assert.equal(pickup.completedCount, 1);
    assert.equal(pickup.replayed, false);

    const pickupReplay = await service.recordJobCheckpoint(
      playerRef, accepted.id, 'warehouse_pickup', pickupEventId, pickupPosition,
    );
    assert.equal(pickupReplay.replayed, true);
    assert.equal(pickupReplay.completedCount, 1);

    await assert.rejects(
      service.recordJobCheckpoint(playerRef, accepted.id, 'warehouse_pickup', pickupEventId, { x: -279, y: 210, z: 0 }),
      assertRidgeErrorCode('SERVER_EVENT_REUSED'),
    );
    await assert.rejects(
      service.recordJobCheckpoint(playerRef, accepted.id, 'delivery_dropoff', pickupEventId, dropoffPosition),
      assertRidgeErrorCode('SERVER_EVENT_REUSED'),
    );

    // A server event ID is globally unique even when different job rows race.
    const racePlayerA = `integration-race-a-${randomUUID()}`;
    const racePlayerB = `integration-race-b-${randomUUID()}`;
    const [raceJobA, raceJobB] = await Promise.all([
      service.acceptJob(racePlayerA, 'delivery_intro'),
      service.acceptJob(racePlayerB, 'delivery_intro'),
    ]);
    const sharedEventId = `it-global-${randomUUID()}`;
    const raceResults = await Promise.allSettled([
      service.recordJobCheckpoint(racePlayerA, raceJobA.id, 'warehouse_pickup', sharedEventId, pickupPosition),
      service.recordJobCheckpoint(racePlayerB, raceJobB.id, 'warehouse_pickup', sharedEventId, pickupPosition),
    ]);
    assert.equal(raceResults.filter((result) => result.status === 'fulfilled').length, 1);
    const raceFailure = raceResults.find((result) => result.status === 'rejected');
    assert.equal(raceFailure.reason?.code, 'SERVER_EVENT_REUSED');

    const dropoff = await service.recordJobCheckpoint(
      playerRef, accepted.id, 'delivery_dropoff', `it-dropoff-${randomUUID()}`, dropoffPosition,
    );
    assert.equal(dropoff.completedCount, 2);

    // The seeded intro job has a 1.5-second minimum duration.
    await delay(1_650);
    const completions = await Promise.all([
      service.completeJob(playerRef, accepted.id, accepted.completionProof),
      service.completeJob(playerRef, accepted.id, accepted.completionProof),
    ]);
    assert.equal(completions.filter((item) => item.replayed === false).length, 1);
    assert.equal(completions.filter((item) => item.replayed === true).length, 1);
    assert.equal(completions[0].transactionId, completions[1].transactionId);
    assert.equal(completions[0].reward, '15.00');

    const audit = await service.getTransactionAudit(completions[0].transactionId);
    assert.equal(audit.balanced, true);
    assert.equal(audit.entryCount, 2);
    assert.equal(audit.totalMinor, 0);

    await service.close();
    service = null;
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    service = await createPostgresGameService({
      pool,
      dedicatedServerId: 'ridge-postgres-integration-test-restart',
    });

    const recoveredWallet = await service.getWallet(playerRef);
    const recoveredJob = await service.getJob(playerRef, accepted.id);
    assert.equal(recoveredWallet.balance, '15.00');
    assert.equal(recoveredWallet.ledgerEntryCount, 1);
    assert.equal(recoveredJob.status, 'completed');
    assert.equal(recoveredJob.completedCheckpoints.length, 2);
  } finally {
    if (service) await service.close();
    else if (pool) await pool.end().catch(() => {});
  }
});
