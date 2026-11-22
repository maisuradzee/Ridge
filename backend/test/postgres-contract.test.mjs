import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  constantTimeHexEqual,
  hashCompletionProof,
  isObservedPositionInsideCheckpoint,
  createPostgresGameService,
} from '../src/postgres-game-service.mjs';

const root = new URL('../../', import.meta.url);

 test('completion proof is stored as a SHA-256 digest, not as plaintext', () => {
  const proof = 'one-time-server-proof-value';
  const digest = hashCompletionProof(proof);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, proof);
  assert.equal(constantTimeHexEqual(digest, hashCompletionProof(proof)), true);
  assert.equal(constantTimeHexEqual(digest, hashCompletionProof('different-proof')), false);
  assert.equal(constantTimeHexEqual('not-a-hash', digest), false);
});

test('PostgreSQL checkpoint validation requires the observed server position inside the configured radius', () => {
  const checkpoint = { local_x_m: -280, local_y_m: 210, local_z_m: 0, radius_m: 7 };
  assert.equal(isObservedPositionInsideCheckpoint(checkpoint, { x: -280, y: 210, z: 1.5 }), true);
  assert.equal(isObservedPositionInsideCheckpoint(checkpoint, { x: -270, y: 210, z: 0 }), false);
  assert.equal(isObservedPositionInsideCheckpoint(checkpoint, { x: -280, y: 210, z: NaN }), false);
  assert.equal(isObservedPositionInsideCheckpoint(checkpoint, { x: -280, y: 210, z: null }), false);
  assert.equal(isObservedPositionInsideCheckpoint(checkpoint, { x: '-280', y: 210, z: 0 }), false);
  assert.equal(isObservedPositionInsideCheckpoint(checkpoint, { x: 10000, y: 10000, z: 0 }), false);
});

test('migration 003 funds reward pool through one balanced idempotent virtual issuance transaction', async () => {
  const sql = await readFile(new URL('database/migrations/003_postgres_runtime.sql', root), 'utf8');
  assert.match(sql, /system-opening:job-reward-pool:v1/);
  assert.match(sql, /100000000/);
  assert.match(sql, /ON CONFLICT \(idempotency_key\) DO NOTHING/);
  assert.match(sql, /RIDGE Job Reward Pool/);
  assert.match(sql, /RIDGE Virtual Issuance/);
  assert.match(sql, /world_epoch_ms/);
});

test('PostgreSQL repository uses database transactions, row locks and a unique idempotency key', async () => {
  const source = await readFile(new URL('backend/src/postgres-game-service.mjs', root), 'utf8');
  assert.match(source, /BEGIN/);
  assert.match(source, /COMMIT/);
  assert.match(source, /ROLLBACK/);
  assert.match(source, /FOR UPDATE/);
  assert.match(source, /job-reward:/);
  assert.match(source, /completion_proof_hash/);
  assert.match(source, /ledger_entries/);
});

test('server exposes PostgreSQL mode and refuses ephemeral production storage', async () => {
  const server = await readFile(new URL('backend/src/server.mjs', root), 'utf8');
  assert.match(server, /RIDGE_STORAGE/);
  assert.match(server, /Production mode cannot use ephemeral in-memory game storage/);
  assert.match(server, /createPostgresGameService/);
  assert.match(server, /observedPosition/);
});


test('PostgreSQL service initializes only after required migrations and preserves world epoch', async () => {
  const seen = [];
  const pool = {
    async query(sql) {
      seen.push(sql);
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (sql.includes("to_regclass('ridge.players')")) {
        return { rows: [{ players: 'ridge.players', player_jobs: 'ridge.player_jobs', checkpoint_definitions: 'ridge.job_checkpoint_definitions', ledger_entries: 'ridge.ledger_entries' }] };
      }
      if (sql.includes("INSERT INTO ridge.world_state")) return { rows: [] };
      if (sql.includes("SELECT (state_value #>> '{}')::bigint")) return { rows: [{ epoch_ms: '1800000000000' }] };
      if (sql.includes("SELECT count(*)::integer AS account_count")) return { rows: [{ account_count: 2 }] };
      throw new Error(`Unexpected SQL in mocked pool: ${sql}`);
    },
    async connect() { throw new Error('connect should not be called for this initialization-only test'); },
    async end() {},
  };
  const service = await createPostgresGameService({ pool, clock: () => 1_800_000_000_000 });
  const world = await service.getWorldState();
  assert.equal(await service.healthCheck(), true);
  assert.equal(service.storageMode, 'postgresql');
  assert.equal(world.worldTime, '08:00');
  assert.equal(world.mode, 'persistent-postgresql');
  assert.equal(seen.length, 6);
});