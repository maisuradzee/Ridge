import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSessionRegistry } from '../src/session-registry.mjs';

const enabled = process.env.RIDGE_RUN_POSTGRES_INTEGRATION === 'YES';
const developmentOnly = process.env.RIDGE_DB_ENV === 'development';
const hasDatabaseUrl = Boolean(process.env.DATABASE_URL);



test('PostgreSQL transport-key registry persists public-only X25519 metadata and rotates without overwriting old key', { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL);
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 3000 });
  const registry = await createSessionRegistry({ pool });
  const suffix = randomUUID();
  const serverId = 'it-key-shard-' + suffix;
  const rawPublic = (n) => Buffer.alloc(32, n).toString('base64url');
  try {
    await registry.registerServer({
      serverId, region: 'ge-tbilisi', host: '127.0.0.1',
      port: 27000 + Math.floor(Math.random() * 1000), maxPlayers: 4, protocolVersion: 'ridge-0.6',
    });
    const firstExpiry = new Date(Date.now() + 120_000).toISOString();
    const first = await registry.publishServerTransportKey({
      serverId, keyId: 'it-key-old', publicKey: rawPublic(0x71), expiresAt: firstExpiry,
    });
    assert.equal(first.replayed, false);
    const stored = await pool.query(
      'SELECT public_key FROM ridge.dedicated_server_transport_keys WHERE server_id = $1 AND key_id = $2',
      [serverId, 'it-key-old'],
    );
    assert.equal(stored.rows[0].public_key, rawPublic(0x71));
    assert.equal(Object.hasOwn(stored.rows[0], 'private_key'), false);

    const second = await registry.publishServerTransportKey({
      serverId, keyId: 'it-key-new', publicKey: rawPublic(0x72),
      expiresAt: new Date(Date.now() + 240_000).toISOString(),
    });
    assert.equal(second.replayed, false);
    assert.equal((await registry.getServerTransportKey({ serverId })).keyId, 'it-key-new');
    assert.equal((await registry.getServerTransportKey({ serverId, keyId: 'it-key-old' })).keyId, 'it-key-old');
  } finally {
    await pool.query('DELETE FROM ridge.dedicated_server_transport_keys WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.query('DELETE FROM ridge.dedicated_server_credentials WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.query('DELETE FROM ridge.player_sessions WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.query('DELETE FROM ridge.dedicated_servers WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.end();
  }
});

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
  const actorId = 'postgres-integration-provisioner';
  const playerIds = Array.from({ length: 12 }, (_, index) => 'it-session-' + index + '-' + suffix);
  try {
    assert.equal(await registry.healthCheck(), true, 'readiness must include the credential registry table');

    const server = await registry.registerServer({
      serverId,
      region: 'ge-tbilisi',
      host: '127.0.0.1',
      port: 20_000 + Math.floor(Math.random() * 1_000),
      maxPlayers: 4,
      protocolVersion: 'ridge-0.6',
    });
    assert.equal(server.status, 'ready');
    const firstCredential = await registry.issueServerCredential({ serverId, actorId });
    assert.match(firstCredential.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await registry.authenticateServerCredential({ serverId, token: firstCredential.token }), true);
    const storedCredential = await pool.query(
      'SELECT token_hash FROM ridge.dedicated_server_credentials WHERE server_id = $1',
      [serverId],
    );
    assert.notEqual(storedCredential.rows[0].token_hash, firstCredential.token);
    assert.match(storedCredential.rows[0].token_hash, /^[a-f0-9]{64}$/);

    const rotatedCredential = await registry.issueServerCredential({ serverId, actorId });
    assert.equal(await registry.authenticateServerCredential({ serverId, token: firstCredential.token }), false);
    assert.equal(await registry.authenticateServerCredential({ serverId, token: rotatedCredential.token }), true);
    assert.equal((await registry.revokeServerCredential({ serverId, actorId })).revoked, true);
    assert.equal(await registry.authenticateServerCredential({ serverId, token: rotatedCredential.token }), false);
    const activeCredential = await registry.issueServerCredential({ serverId, actorId });
    assert.equal(await registry.authenticateServerCredential({ serverId, token: activeCredential.token }), true);

    const credentialEvents = await registry.listServerCredentialEvents({ serverId, limit: 10 });
    assert.deepEqual(credentialEvents.map((event) => event.action), [
      'issued',
      'revoked',
      'rotated',
      'issued',
    ]);
    assert.equal(credentialEvents[2].credentialId, rotatedCredential.credentialId);
    assert.equal(credentialEvents[2].previousCredentialId, firstCredential.credentialId);
    assert.ok(credentialEvents.every((event) =>
      event.actorType === 'service' &&
      event.actorId === actorId &&
      !Object.hasOwn(event, 'token') && !Object.hasOwn(event, 'tokenHash')
    ));

    await assert.rejects(
      pool.query(
        'UPDATE ridge.dedicated_server_credential_events SET action = action WHERE server_id = $1',
        [serverId],
      ),
      (error) => error.code === '55000',
    );
    await assert.rejects(
      pool.query(
        'DELETE FROM ridge.dedicated_server_credential_events WHERE server_id = $1',
        [serverId],
      ),
      (error) => error.code === '55000',
    );

    const attempts = await Promise.allSettled(
      playerIds.map((playerId) => registry.allocatePlayer(playerId, 'ge-tbilisi')),
    );
    const allocations = attempts.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const rejected = attempts.filter((item) => item.status === 'rejected');
    assert.equal(allocations.length, 4, 'no more than the configured four slots may be reserved');
    assert.equal(rejected.length, 8);
    assert.ok(rejected.every((item) => item.reason.code === 'NO_AVAILABLE_SHARD'));
    assert.ok(allocations.every((item) => item.server.serverId === serverId));

    await assert.rejects(
      registry.registerServer({
        serverId,
        region: 'ge-tbilisi',
        host: '127.0.0.1',
        port: 20_000 + Math.floor(Math.random() * 1_000),
        maxPlayers: 4,
        protocolVersion: 'ridge-0.6',
      }),
      (error) => error.code === 'SHARD_INSTANCE_ID_IN_USE',
    );

    const firstPlayer = allocations[0].playerId;
    const first = allocations[0];
    await assert.rejects(
      registry.allocatePlayer(firstPlayer, 'ge-batumi'),
      (error) => error.code === 'SESSION_REGION_TRANSFER_REQUIRED',
    );
    const replay = await registry.allocatePlayer(firstPlayer, 'ge-tbilisi');
    assert.equal(replay.sessionId, first.sessionId);
    assert.equal(replay.reused, true);

    const issued = await registry.issueJoinTicket({
      playerId: firstPlayer,
      sessionId: first.sessionId,
      serverId,
    });
    assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
    const storedTicket = await pool.query(
      'SELECT join_ticket_hash, join_attempt_id FROM ridge.player_sessions WHERE session_id = $1',
      [first.sessionId],
    );
    assert.notEqual(storedTicket.rows[0].join_ticket_hash, issued.ticket);
    assert.match(storedTicket.rows[0].join_ticket_hash, /^[a-f0-9]{64}$/);
    assert.equal(storedTicket.rows[0].join_attempt_id, issued.claimAttemptId);
    await assert.rejects(
      registry.issueJoinTicket({ playerId: firstPlayer, sessionId: first.sessionId, serverId }),
      (error) => error.code === 'SESSION_JOIN_TICKET_ALREADY_ISSUED',
    );
    const claimAttemptId = issued.claimAttemptId;
    await assert.rejects(
      registry.claimJoinTicket({ serverId, ticket: issued.ticket, claimAttemptId: randomUUID() }),
      (error) => error.code === 'JOIN_TICKET_CLAIM_ATTEMPT_MISMATCH',
    );
    const claimed = await registry.claimJoinTicket({
      serverId,
      ticket: issued.ticket,
      claimAttemptId,
    });
    assert.equal(claimed.playerId, firstPlayer);
    assert.equal(claimed.sessionId, first.sessionId);
    assert.equal(claimed.connected, true);
    assert.equal(claimed.replayed, false);
    const claimReplay = await registry.claimJoinTicket({
      serverId,
      ticket: issued.ticket,
      claimAttemptId,
    });
    assert.equal(claimReplay.replayed, true);
    await assert.rejects(
      registry.claimJoinTicket({
        serverId,
        ticket: issued.ticket,
        claimAttemptId: randomUUID(),
      }),
      (error) => error.code === 'JOIN_TICKET_ALREADY_USED',
    );

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
    await pool.query('DELETE FROM ridge.dedicated_server_credentials WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.query('DELETE FROM ridge.player_sessions WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.query('DELETE FROM ridge.dedicated_servers WHERE server_id = $1', [serverId]).catch(() => {});
    await pool.end();
  }
});
