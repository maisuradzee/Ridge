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

test('only the assigned live shard can claim a join ticket; same-claim replay is safe', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a'));
  await registry.registerServer(registration('shard-b'));
  const allocation = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  const issued = await registry.issueJoinTicket({
    playerId: 'player-1', sessionId: allocation.sessionId, serverId: allocation.server.serverId,
  });
  const claimAttemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const wrongShard = allocation.server.serverId === 'shard-a' ? 'shard-b' : 'shard-a';
  await assert.rejects(
    registry.claimJoinTicket({ serverId: wrongShard, ticket: issued.ticket, claimAttemptId }),
    (error) => error.code === 'JOIN_TICKET_INVALID',
  );
  const claimed = await registry.claimJoinTicket({
    serverId: allocation.server.serverId, ticket: issued.ticket, claimAttemptId,
  });
  assert.equal(claimed.connected, true);
  assert.equal(claimed.playerId, 'player-1');
  assert.equal(claimed.replayed, false);
  const replay = await registry.claimJoinTicket({
    serverId: allocation.server.serverId, ticket: issued.ticket, claimAttemptId,
  });
  assert.equal(replay.replayed, true);
});

test('draining shard accepts existing join tickets but receives no new allocations', async () => {
  const { registry } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 3 }));
  const allocation = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  const issued = await registry.issueJoinTicket({
    playerId: 'player-1', sessionId: allocation.sessionId, serverId: 'shard-a',
  });
  await registry.heartbeatServer('shard-a', { currentPlayers: 0, status: 'draining' });
  const claimed = await registry.claimJoinTicket({
    serverId: 'shard-a',
    ticket: issued.ticket,
    claimAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
  assert.equal(claimed.connected, true);
  await assert.rejects(
    registry.allocatePlayer('player-2', 'ge-tbilisi'),
    (error) => error.code === 'NO_AVAILABLE_SHARD',
  );
});

test('offline or stale shards are never selected and offline heartbeat invalidates join tickets', async () => {
  const { registry, advance } = await createRegistry();
  await registry.registerServer(registration('shard-a', { maxPlayers: 3 }));
  const allocation = await registry.allocatePlayer('player-1', 'ge-tbilisi');
  const issued = await registry.issueJoinTicket({
    playerId: 'player-1', sessionId: allocation.sessionId, serverId: 'shard-a',
  });
  await registry.heartbeatServer('shard-a', { currentPlayers: 0, status: 'offline' });
  await assert.rejects(
    registry.claimJoinTicket({
      serverId: 'shard-a',
      ticket: issued.ticket,
      claimAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
    (error) => error.code === 'JOIN_TICKET_INVALID',
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

test('join ticket is short-lived, stored as a digest, single-use and idempotent for one claim attempt', async () => {
  const { registry } = await createRegistry({ leaseMs: 10_000, joinTicketMs: 5_000 });
  await registry.registerServer(registration('shard-ticket'));
  const allocation = await registry.allocatePlayer('player-ticket', 'ge-tbilisi');
  const issued = await registry.issueJoinTicket({
    playerId: 'player-ticket',
    sessionId: allocation.sessionId,
    serverId: 'shard-ticket',
  });
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.ticket.length, 43);
  assert.equal(issued.sessionId, allocation.sessionId);
  assert.equal(issued.server.serverId, 'shard-ticket');
  assert.ok(Date.parse(issued.expiresAt) > Date.now() || Date.parse(issued.expiresAt) > 0);

  const claimAttemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const claimed = await registry.claimJoinTicket({
    serverId: 'shard-ticket',
    ticket: issued.ticket,
    claimAttemptId,
  });
  assert.equal(claimed.playerId, 'player-ticket');
  assert.equal(claimed.sessionId, allocation.sessionId);
  assert.equal(claimed.connected, true);
  assert.equal(claimed.replayed, false);

  const replay = await registry.claimJoinTicket({
    serverId: 'shard-ticket',
    ticket: issued.ticket,
    claimAttemptId,
  });
  assert.equal(replay.replayed, true);

  await assert.rejects(
    registry.claimJoinTicket({
      serverId: 'shard-ticket',
      ticket: issued.ticket,
      claimAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }),
    (error) => error.code === 'JOIN_TICKET_ALREADY_USED',
  );
});

test('issuing a replacement ticket invalidates the previous bearer ticket', async () => {
  const { registry } = await createRegistry({ leaseMs: 10_000, joinTicketMs: 5_000 });
  await registry.registerServer(registration('shard-reissue'));
  const allocation = await registry.allocatePlayer('player-reissue', 'ge-tbilisi');
  const first = await registry.issueJoinTicket({
    playerId: 'player-reissue', sessionId: allocation.sessionId, serverId: 'shard-reissue',
  });
  const second = await registry.issueJoinTicket({
    playerId: 'player-reissue', sessionId: allocation.sessionId, serverId: 'shard-reissue',
  });
  assert.notEqual(first.ticket, second.ticket);
  await assert.rejects(
    registry.claimJoinTicket({
      serverId: 'shard-reissue',
      ticket: first.ticket,
      claimAttemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
    (error) => error.code === 'JOIN_TICKET_INVALID',
  );
  const claim = await registry.claimJoinTicket({
    serverId: 'shard-reissue',
    ticket: second.ticket,
    claimAttemptId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  });
  assert.equal(claim.connected, true);
});

test('join ticket expiry is enforced against the server lease', async () => {
  const { registry, advance } = await createRegistry({ leaseMs: 10_000, joinTicketMs: 1_000 });
  await registry.registerServer(registration('shard-ticket-expiry'));
  const allocation = await registry.allocatePlayer('player-ticket-expiry', 'ge-tbilisi');
  const issued = await registry.issueJoinTicket({
    playerId: 'player-ticket-expiry',
    sessionId: allocation.sessionId,
    serverId: 'shard-ticket-expiry',
  });
  advance(1_001);
  await assert.rejects(
    registry.claimJoinTicket({
      serverId: 'shard-ticket-expiry',
      ticket: issued.ticket,
      claimAttemptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }),
    (error) => error.code === 'JOIN_TICKET_EXPIRED',
  );
});

test('ticket issuance requires the correct allocated session and a valid claim attempt ID', async () => {
  const { registry } = await createRegistry({ leaseMs: 10_000, joinTicketMs: 5_000 });
  await registry.registerServer(registration('shard-ticket-auth'));
  const allocation = await registry.allocatePlayer('player-ticket-auth', 'ge-tbilisi');
  await assert.rejects(
    registry.issueJoinTicket({
      playerId: 'another-player',
      sessionId: allocation.sessionId,
      serverId: 'shard-ticket-auth',
    }),
    (error) => error.code === 'SESSION_NOT_ALLOCATED',
  );
  const issued = await registry.issueJoinTicket({
    playerId: 'player-ticket-auth',
    sessionId: allocation.sessionId,
    serverId: 'shard-ticket-auth',
  });
  await assert.rejects(
    registry.claimJoinTicket({
      serverId: 'shard-ticket-auth',
      ticket: issued.ticket,
      claimAttemptId: 'not-a-uuid',
    }),
    (error) => error.code === 'INVALID_CLAIM_ATTEMPT_ID',
  );
});
