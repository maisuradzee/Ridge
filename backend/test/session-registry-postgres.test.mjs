import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSessionRegistry } from '../src/session-registry.mjs';

const enabled = process.env.RIDGE_RUN_POSTGRES_INTEGRATION === 'YES';
const developmentOnly = process.env.RIDGE_DB_ENV === 'development';
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);

test('PostgreSQL session registry serializes shard capacity, reuses leases, claims and releases safely', {
  skip: !enabled
    ? 'Set RIDGE_RUN_POSTGRES_INTEGRATION=YES to run against a dedicated development database.'
    : !developmentOnly
      ? 'Safety stop: RIDGE_DB_ENV must equal development.'
      : !hasDatabaseUrl
        ? 'DATABASE_URL is required.'
        : false,
}, async () => {
  assert.equal(developmentOnly, true, 'Session integration may run only against a development database.');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const registry = await createSessionRegistry({ pool });
  const suffix = randomUUID();
  const serverId = 'it-shard-' + suffix;
  const playerIds = Array.from({ length: 12 }, (_, index) => 'it-session-' + index + '-' + suffix);
  try {
    const server = await registry.registerServer({
      serverId,
      region: 'ge-tbilisi',
      host: '127.0.0.1',
      port: 20_000 + Math.floor(Math.random() * 1_000),
      maxPlayers: 4,
      protocolVersion: 'ridge-0.6',
    });
    assert.equal(server.status, 'ready');

    const attempts = await Promise.allSettled(
      playerIds.map((playerId) => registry.allocatePlayer(playerId, 'ge-tbilisi')),
    );
    const allocations = attempts.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const rejected = attempts.filter((item) => item.status === 'rejected');
    assert.equal(allocations.length, 4, 'no more than the configured four slots may be reserved');
    assert.equal(rejected.length, 8);
    assert.ok(rejected.every((item) => item.reason.code === 'NO_AVAILABLE_SHARD'));
    assert.ok(allocations.every((item) => item.server.serverId === serverId));

    const firstPlayer = allocations[0].playerId;
    const first = allocations[0];
    const replay = await registry.allocatePlayer(firstPlayer, 'ge-tbilisi');
    assert.equal(replay.sessionId, first.sessionId);
    assert.equal(replay.reused, true);

    const claimed = await registry.claimSession({
      playerId: firstPlayer,
      sessionId: first.sessionId,
      serverId,
    });
    assert.equal(claimed.connected, true);
    assert.equal(claimed.replayed, false);
    const claimReplay = await registry.claimSession({
      playerId: firstPlayer,
      sessionId: first.sessionId,
      serverId,
    });
    assert.equal(claimReplay.replayed, true);

    const toRelease = allocations[1];
    const released = await registry.releaseSession({
      playerId: toRelease.playerId,
      sessionId: toRelease.sessionId,
      serverId,
    });
    assert.deepEqual(released, { released: true, replayed: false });
    const releaseReplay = await registry.releaseSession({
      playerId: toRelease.playerId,
      sessionId: toRelease.sessionId,
      serverId,
    });
    assert.deepEqual(releaseReplay, { released: true, replayed: true });

    const replacement = await registry.allocatePlayer('it-replacement-' + suffix, 'ge-tbilisi');
    assert.equal(replacement.server.serverId, serverId);

    await registry.heartbeatServer(serverId, { currentPlayers: 1, status: 'ready' });
    const [listed] = await registry.listServers('ge-tbilisi');
    assert.equal(listed.heartbeatFresh, true);
    assert.equal(listed.connectedSessions, 1);
    assert.equal(listed.reservedPlayers, 3);

    await registry.heartbeatServer(serverId, { currentPlayers: 0, status: 'offline' });
    const unavailable = await Promise.allSettled([
      registry.allocatePlayer('it-after-offline-' + suffix, 'ge-tbilisi'),
    ]);
    assert.equal(unavailable[0].status, 'rejected');
    assert.equal(unavailable[0].reason.code, 'NO_AVAILABLE_SHARD');
  } finally {
    await pool.query('DELETE FROM ridge.player_sessions WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.query('DELETE FROM ridge.dedicated_servers WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.end();
  }
});
