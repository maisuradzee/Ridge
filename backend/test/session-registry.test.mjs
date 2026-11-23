import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRegistry } from '../src/session-registry.mjs';

const registration = (serverId, overrides = {}) => ({
  serverId,
  region: 'ge-tbilisi',
  host: '127.0.0.1',
  port: 8000,
  maxPlayers: 2,
  protocolVersion: 'ridge-0.6',
  ...overrides,
});

async function createRegistry(options = {}) {
  let now = 1_800_000_000_000;
  const registry = await createSessionRegistry({
    clock: () => now,
    leaseMs: 1_000,
    heartbeatTtlMs: 5_000,
    ...options,
  });
  return {
    registry,
    advance: (milliseconds) => { now += milliseconds; },
  };
}

test('registration validates server address, port, region and bounded capacity', async () => {
  const { registry } = await createRegistry();
  const server = await registry.registerServer(registration('shard-a'));
  assert.equal(server.serverId, 'shard-a');
  assert.equal(server.region, 'ge-tbilisi');
  assert.equal(server.status, 'ready');
  await assert.rejects(
    registry.registerServer(registration('shard-b', { host: 'https://bad.example' })),
    (error) => error.code === 'INVALID_SHARD_HOST',
  );
  await assert.rejects(
    registry.registerServer(registration('shard-c', { port: 70000 })),
    (error) => error.code === 'INVALID_SHARD_PORT',
  );
  await assert.rejects(
    registry.registerServer(registration('shard-d', { maxPlayers: 251 })),
    (error) => error.code === 'INVALID_SHARD_CAPACITY',
  );
});

test('heartbeat bounds live player counts and lists server health', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 4 }));
  const heartbeat = await registry.heartbeatServer('shard-a', { currentPlayers: 3, status: 'ready' });
  assert.equal(heartbeat.currentPlayers, 3);
  const [listed] = await registry.listServers('ge-tbilisi');
  assert.equal(listed.heartbeatFresh, true);
  assert.equal(listed.reservedPlayers, 0);
  await assert.rejects(
    registry.heartbeatServer('shard-a', { currentPlayers: 5, status: 'ready' }),
    (error) => error.code === 'INVALID_SHARD_PLAYER_COUNT',
  );
});

test('allocator chooses a healthy shard with the lowest utilization and reserves slots', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 2 }));
  await registry.registerServer(registration('shard-b', { maxPlayers: 2 }));
  await registry.heartbeatServer('shard-b', { currentPlayers: 1, status: 'ready' });

  const first = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  const second = await registry.allocatePlayer('player-2', 'ge-tbilisi');
  const third = await registry.allocatePlayer('player-3', 'ge-tbilisi');
  assert.equal(first.server.serverId, 'shard-a');
  assert.equal(second.server.serverId, 'shard-a');
  assert.equal(third.server.serverId, 'shard-b');
  const listed = await registry.listServers();
  assert.equal(listed.find((item) => item.serverId === 'shard-a').reservedPlayers, 2);
});

test('allocation is idempotent while a lease remains valid and reissues after expiry', async () => {
  const { registry, advance } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 3 }));
  const first = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  await assert.rejects(
    registry.registerServer(registration('shard-a', { maxPlayers: 3 })),
    (error) => error.code === 'SHARD_INSTANCE_ID_IN_USE',
  );
  const replay = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  assert.equal(replay.sessionId, first.sessionId);
  assert.equal(replay.reused, true);

  advance(1_001);
  const renewed = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  assert.notEqual(renewed.sessionId, first.sessionId);
  assert.equal(renewed.reused, false);
});

test('only the assigned live shard can claim a lease; claim replay is safe', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a'));
  await registry.registerServer(registration('shard-b'));
  const allocation = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  const wrongShard = allocation.server.serverId === 'shard-a' ? 'shard-b' : 'shard-a';
  await assert.rejects(
    registry.claimSession({ playerId: 'player-1', sessionId: allocation.sessionId, serverId: wrongShard }),
    (error) => error.code === 'SESSION_NOT_FOUND',
  );
  const claimed = await registry.claimSession({
    playerId: 'player-1', sessionId: allocation.sessionId, serverId: allocation.server.serverId,
  });
  assert.equal(claimed.connected, true);
  assert.equal(claimed.replayed, false);
  const replay = await registry.claimSession({
    playerId: 'player-1', sessionId: allocation.sessionId, serverId: allocation.server.serverId,
  });
  assert.equal(replay.replayed, true);
});

test('draining shard accepts existing leases but receives no new allocations', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 3 }));
  const allocation = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  await registry.heartbeatServer('shard-a', { currentPlayers: 0, status: 'draining' });
  const claimed = await registry.claimSession({
    playerId: 'player-1', sessionId: allocation.sessionId, serverId: 'shard-a',
  });
  assert.equal(claimed.connected, true);
  await assert.rejects(
    registry.allocatePlayer('player-2', 'ge-tbilisi'),
    (error) => error.code === 'NO_AVAILABLE_SHARD',
  );
});

test('offline or stale shards are never selected and offline heartbeat expires sessions', async () => {
  const { registry, advance } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 3 }));
  const allocation = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  await registry.heartbeatServer('shard-a', { currentPlayers: 0, status: 'offline' });
  await assert.rejects(
    registry.claimSession({ playerId: 'player-1', sessionId: allocation.sessionId, serverId: 'shard-a' }),
    (error) => error.code === 'SESSION_NOT_FOUND',
  );
  await assert.rejects(
    registry.allocatePlayer('player-2', 'ge-tbilisi'),
    (error) => error.code === 'NO_AVAILABLE_SHARD',
  );

  await registry.registerServer(registration('shard-b'));
  advance(5_001);
  await assert.rejects(
    registry.allocatePlayer('player-3', 'ge-tbilisi'),
    (error) => error.code === 'NO_AVAILABLE_SHARD',
  );
});

test('release is idempotent and immediately frees a reserved slot', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a'));
  const first = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  const released = await registry.releaseSession({
    playerId: 'player-1', sessionId: first.sessionId, serverId: 'shard-a',
  });
  assert.deepEqual(released, { released: true, replayed: false });
  const replay = await registry.releaseSession({
    playerId: 'player-1', sessionId: first.sessionId, serverId: 'shard-a',
  });
  assert.deepEqual(replay, { released: true, replayed: true });
  const next = await registry.allocatePlayer('player-2', 'ge-tbilisi');
  assert.equal(next.server.serverId, 'shard-a');
});

test('allocator refuses regions without capacity and rejects malformed player IDs', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 1 }));
  await registry.allocatePlayer('player-1', 'ge-tbilisi');
  await assert.rejects(
    registry.allocatePlayer('player-2', 'ge-tbilisi'),
    (error) => error.code === 'NO_AVAILABLE_SHARD',
  );
  await assert.rejects(
    registry.allocatePlayer('../bad', 'ge-tbilisi'),
    (error) => error.code === 'INVALID_PLAYER_ID',
  );
});


test('an active player session cannot silently change regions', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 2 }));
  const allocation = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  await assert.rejects(
    registry.allocatePlayer('player-1', 'ge-batumi'),
    (error) => error.code === 'SESSION_REGION_TRANSFER_REQUIRED',
  );
  const replay = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  assert.equal(replay.sessionId, allocation.sessionId);
  assert.equal(replay.server.region, 'ge-tbilisi');
});
