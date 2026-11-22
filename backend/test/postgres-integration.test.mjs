import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgresGameService } from '../src/postgres-game-service.mjs';

const enabled = process.env.RIDGE_RUN_POSTGRES_INTEGRATION === 'YES';
const developmentOnly = process.env.RIDGE_DB_ENV === 'development';
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

test('PostgreSQL integration: persists player, job, checkpoint proofs and one balanced reward across restart', {
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
  let pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let service = await createPostgresGameService({
    pool,
    dedicatedServerId: 'ridge-postgres-integration-test',
  });

  const playerRef = `integration-${randomUUID()}`;
  const accepted = await service.acceptJob(playerRef, 'delivery_intro');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.requiredCheckpoints.length, 2);

  await assert.rejects(
    service.recordJobCheckpoint(playerRef, accepted.id, 'delivery_dropoff', `it-out-of-order-${randomUUID()}`, { x: 270, y: -180, z: 0 }),
    (error) => error.code === 'CHECKPOINT_OUT_OF_ORDER',
  );
  await assert.rejects(
    service.recordJobCheckpoint(playerRef, accepted.id, 'warehouse_pickup', `it-outside-radius-${randomUUID()}`, { x: -250, y: 210, z: 0 }),
    (error) => error.code === 'CHECKPOINT_POSITION_INVALID',
  );

  const pickupEventId = `it-pickup-${randomUUID()}`;
  const pickupPosition = { x: -280, y: 210, z: 0 };
  const pickup = await service.recordJobCheckpoint(
    playerRef,
    accepted.id,
    'warehouse_pickup',
    pickupEventId,
    pickupPosition,
  );
  assert.equal(pickup.completedCount, 1);
  const pickupReplay = await service.recordJobCheckpoint(
    playerRef, accepted.id, 'warehouse_pickup', pickupEventId, pickupPosition,
  );
  assert.equal(pickupReplay.replayed, true);
  await assert.rejects(
    service.recordJobCheckpoint(playerRef, accepted.id, 'delivery_dropoff', pickupEventId, { x: 270, y: -180, z: 0 }),
    (error) => error.code === 'SERVER_EVENT_REUSED',
  );
  await assert.rejects(
    service.recordJobCheckpoint(playerRef, accepted.id, 'warehouse_pickup', pickupEventId, { x: -279, y: 210, z: 0 }),
    (error) => error.code === 'SERVER_EVENT_REUSED',
  );

  const dropoff = await service.recordJobCheckpoint(
    playerRef,
    accepted.id,
    'delivery_dropoff',
    `it-dropoff-${randomUUID()}`,
    { x: 270, y: -180, z: 0 },
  );
  assert.equal(dropoff.completedCount, 2);

  // The seeded intro job has a 1.5-second minimum duration.
  await delay(1_650);
  const [first, replay] = await Promise.all([
    service.completeJob(playerRef, accepted.id, accepted.completionProof),
    service.completeJob(playerRef, accepted.id, accepted.completionProof),
  ]);
  assert.equal([first, replay].filter((item) => item.replayed === false).length, 1);
  assert.equal([first, replay].filter((item) => item.replayed === true).length, 1);
  assert.equal(first.transactionId, replay.transactionId);
  assert.equal(first.reward, '15.00');

  // A global event ID cannot be claimed by two different jobs concurrently.
  const otherPlayerA = `integration-cross-a-${randomUUID()}`;
  const otherPlayerB = `integration-cross-b-${randomUUID()}`;
  const jobA = await service.acceptJob(otherPlayerA, 'delivery_intro');
  const jobB = await service.acceptJob(otherPlayerB, 'delivery_intro');
  const sharedEventId = `it-shared-event-${randomUUID()}`;
  const crossJob = await Promise.allSettled([
    service.recordJobCheckpoint(otherPlayerA, jobA.id, 'warehouse_pickup', sharedEventId, { x: -280, y: 210, z: 0 }),
    service.recordJobCheckpoint(otherPlayerB, jobB.id, 'warehouse_pickup', sharedEventId, { x: -280, y: 210, z: 0 }),
  ]);
  assert.equal(crossJob.filter((item) => item.status === 'fulfilled').length, 1);
  const rejectedCrossJob = crossJob.find((item) => item.status === 'rejected');
  assert.equal(rejectedCrossJob.reason.code, 'SERVER_EVENT_REUSED');

  const audit = await service.getTransactionAudit(first.transactionId);
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
  assert.equal(recoveredJob.status, 'completed');
  assert.equal(recoveredJob.completedCheckpoints.length, 2);

  await service.close();
});