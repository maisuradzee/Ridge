import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameService, RidgeError } from '../src/game-service.mjs';

function makeService() {
  let now = 1_800_000_000_000;
  const service = createGameService({ clock: () => now, treasurySeedMinor: 1_000_000 });
  return { service, advance: (ms) => { now += ms; } };
}

function recordDeliveryPath(service, playerId, jobId) {
  service.recordJobCheckpoint(playerId, jobId, 'warehouse_pickup', 'evt-pickup-000001');
  service.recordJobCheckpoint(playerId, jobId, 'delivery_dropoff', 'evt-dropoff-0001');
}

test('new player starts with a zero GEL wallet', () => {
  const { service } = makeService();
  const wallet = service.getWallet('player-1');
  assert.equal(wallet.balanceMinor, 0);
  assert.equal(wallet.balance, '0.00');
  assert.equal(wallet.currency, 'GEL');
  const profile = service.getPlayer('player-1');
  assert.equal(profile.id, 'player-1');
  assert.equal('walletAccountId' in profile, false);
  assert.equal('balanceMinor' in profile, false);
});

test('job cannot be completed before server minimum duration', () => {
  const { service } = makeService();
  const job = service.acceptJob('player-1');
  assert.throws(
    () => service.completeJob('player-1', job.id, job.completionProof),
    (error) => error instanceof RidgeError && error.code === 'JOB_CHECKPOINTS_INCOMPLETE',
  );
  recordDeliveryPath(service, 'player-1', job.id);
  assert.throws(
    () => service.completeJob('player-1', job.id, job.completionProof),
    (error) => error instanceof RidgeError && error.code === 'JOB_COMPLETED_TOO_SOON',
  );
});

test('completed job credits the wallet exactly once on replay', () => {
  const { service, advance } = makeService();
  const job = service.acceptJob('player-1');
  recordDeliveryPath(service, 'player-1', job.id);
  advance(2_000);

  const first = service.completeJob('player-1', job.id, job.completionProof);
  const replay = service.completeJob('player-1', job.id, job.completionProof);
  const wallet = service.getWallet('player-1');
  const entries = service.getLedger('player-1');

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.transactionId, replay.transactionId);
  assert.equal(wallet.balanceMinor, 1_500);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].amountMinor, 1_500);
});

test('completion proof is bound to the player and job', () => {
  const { service, advance } = makeService();
  const job = service.acceptJob('player-1');
  advance(2_000);
  assert.throws(
    () => service.completeJob('player-2', job.id, job.completionProof),
    (error) => error instanceof RidgeError && error.code === 'JOB_NOT_FOUND',
  );
  assert.throws(
    () => service.completeJob('player-1', job.id, 'wrong-proof'),
    (error) => error instanceof RidgeError && error.code === 'INVALID_COMPLETION_PROOF',
  );
});

test('a player cannot accept a second active job', () => {
  const { service } = makeService();
  service.acceptJob('player-1');
  assert.throws(
    () => service.acceptJob('player-1'),
    (error) => error instanceof RidgeError && error.code === 'ACTIVE_JOB_EXISTS',
  );
});

test('ledger entries for a reward are balanced across player and treasury accounts', () => {
  const { service, advance } = makeService();
  const job = service.acceptJob('player-1');
  recordDeliveryPath(service, 'player-1', job.id);
  advance(2_000);
  const result = service.completeJob('player-1', job.id, job.completionProof);
  const audit = service.getTransactionAudit(result.transactionId);
  assert.equal(audit.entryCount, 2);
  assert.equal(audit.totalMinor, 0);
  assert.equal(audit.balanced, true);
  assert.equal(service.getWallet('player-1').balanceMinor, 1_500);
});

test('world clock starts at 08:00 and advances six game seconds per real second', () => {
  const { service, advance } = makeService();
  assert.equal(service.getWorldState().worldTime, '08:00');
  advance(10_000);
  assert.equal(service.getWorldState().worldTime, '08:01');
});

test('parallel completion retries still create only one reward transaction', async () => {
  const { service, advance } = makeService();
  const job = service.acceptJob('player-1');
  recordDeliveryPath(service, 'player-1', job.id);
  advance(2_000);
  const results = await Promise.all([
    Promise.resolve().then(() => service.completeJob('player-1', job.id, job.completionProof)),
    Promise.resolve().then(() => service.completeJob('player-1', job.id, job.completionProof)),
  ]);
  assert.equal(service.getWallet('player-1').balanceMinor, 1_500);
  assert.equal(new Set(results.map((result) => result.transactionId)).size, 1);
  assert.equal(results.filter((result) => result.replayed === false).length, 1);
});


test('delivery job must follow checkpoint order', () => {
  const { service } = makeService();
  const job = service.acceptJob('player-1');
  assert.throws(
    () => service.recordJobCheckpoint('player-1', job.id, 'delivery_dropoff', 'evt-dropoff-0002'),
    (error) => error instanceof RidgeError && error.code === 'CHECKPOINT_OUT_OF_ORDER',
  );
  const pickup = service.recordJobCheckpoint('player-1', job.id, 'warehouse_pickup', 'evt-pickup-0002');
  assert.equal(pickup.completedCount, 1);
  const dropoff = service.recordJobCheckpoint('player-1', job.id, 'delivery_dropoff', 'evt-dropoff-0002');
  assert.equal(dropoff.completedCount, 2);
});

test('checkpoint event replay cannot advance progress twice', () => {
  const { service } = makeService();
  const job = service.acceptJob('player-1');
  const first = service.recordJobCheckpoint('player-1', job.id, 'warehouse_pickup', 'evt-pickup-0003');
  const replay = service.recordJobCheckpoint('player-1', job.id, 'warehouse_pickup', 'evt-pickup-0003');
  const duplicateOverlap = service.recordJobCheckpoint('player-1', job.id, 'warehouse_pickup', 'evt-pickup-0004');
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(duplicateOverlap.replayed, true);
  assert.equal(service.getJob('player-1', job.id).completedCheckpoints.length, 1);
});

test('job status is private to its owning player and omits proof secrets', () => {
  const { service } = makeService();
  const job = service.acceptJob('player-1');
  assert.throws(() => service.getJob('player-2', job.id), (error) => error.code === 'JOB_NOT_FOUND');
  const visible = service.getJob('player-1', job.id);
  assert.equal('completionProof' in visible, false);
  assert.equal(visible.requiredCheckpoints.length, 2);
});

test('job completion requires all server-recorded checkpoints', () => {
  const { service, advance } = makeService();
  const job = service.acceptJob('player-1');
  service.recordJobCheckpoint('player-1', job.id, 'warehouse_pickup', 'evt-pickup-0005');
  advance(2_000);
  assert.throws(
    () => service.completeJob('player-1', job.id, job.completionProof),
    (error) => error instanceof RidgeError && error.code === 'JOB_CHECKPOINTS_INCOMPLETE',
  );
});