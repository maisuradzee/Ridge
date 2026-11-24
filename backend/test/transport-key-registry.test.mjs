import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRegistry } from '../src/session-registry.mjs';

const server = (serverId) => ({
  serverId, region: 'ge-tbilisi', host: '127.0.0.1', port: 7777,
  maxPlayers: 8, protocolVersion: 'ridge-0.6',
});
const publicKey = (octet) => Buffer.alloc(32, octet).toString('base64url');

async function setup(options = {}) {
  let now = 1_800_000_000_000;
  const registry = await createSessionRegistry({ clock: () => now, ...options });
  return { registry, now: () => now, advance: (ms) => { now += ms; } };
}

test('Dedicated Server publishes only a live X25519 public key and Gateway reads the newest active key', async () => {
  const { registry, now, advance } = await setup({ heartbeatTtlMs: 300_000 });
  await registry.registerServer(server('transport-shard-a'));
  const first = await registry.publishServerTransportKey({
    serverId: 'transport-shard-a', keyId: 'key-001', publicKey: publicKey(0x11),
    expiresAt: new Date(now() + 120_000).toISOString(),
  });
  assert.equal(first.replayed, false);
  assert.equal(first.algorithm, 'X25519');
  assert.equal(first.publicKey, publicKey(0x11));
  assert.equal('privateKey' in first, false);
  assert.deepEqual(await registry.getServerTransportKey({ serverId: 'transport-shard-a' }), {
    serverId: 'transport-shard-a', keyId: 'key-001', algorithm: 'X25519',
    publicKey: publicKey(0x11),
    expiresAt: new Date(now() + 120_000).toISOString(),
    createdAt: first.createdAt,
  });

  const replay = await registry.publishServerTransportKey({
    serverId: 'transport-shard-a', keyId: 'key-001', publicKey: publicKey(0x11),
    expiresAt: new Date(now() + 120_000).toISOString(),
  });
  assert.equal(replay.replayed, true);
  await assert.rejects(
    registry.publishServerTransportKey({
      serverId: 'transport-shard-a', keyId: 'key-001', publicKey: publicKey(0x22),
      expiresAt: new Date(now() + 120_000).toISOString(),
    }),
    (error) => error.code === 'TRANSPORT_KEY_ID_CONFLICT',
  );

  const second = await registry.publishServerTransportKey({
    serverId: 'transport-shard-a', keyId: 'key-002', publicKey: publicKey(0x22),
    expiresAt: new Date(now() + 240_000).toISOString(),
  });
  assert.equal(second.replayed, false);
  assert.equal((await registry.getServerTransportKey({ serverId: 'transport-shard-a' })).keyId, 'key-002');
  assert.equal((await registry.getServerTransportKey({ serverId: 'transport-shard-a', keyId: 'key-001' })).keyId, 'key-001');
  advance(130_000);
  assert.equal(await registry.getServerTransportKey({ serverId: 'transport-shard-a', keyId: 'key-001' }), null);
  assert.equal((await registry.getServerTransportKey({ serverId: 'transport-shard-a' })).keyId, 'key-002');
});

test('transport key publication rejects invalid, expired and overlong key metadata', async () => {
  const { registry, now } = await setup();
  await registry.registerServer(server('transport-shard-b'));
  const base = { serverId: 'transport-shard-b', keyId: 'key-invalid', publicKey: publicKey(0x33) };
  const nonCanonical = base.publicKey.slice(0, -1) + 'h';
  await assert.rejects(
    registry.publishServerTransportKey({ ...base, publicKey: 'not-a-key', expiresAt: new Date(now() + 120_000).toISOString() }),
    (error) => error.code === 'INVALID_TRANSPORT_PUBLIC_KEY',
  );
  await assert.rejects(
    registry.publishServerTransportKey({ ...base, publicKey: nonCanonical, expiresAt: new Date(now() + 120_000).toISOString() }),
    (error) => error.code === 'INVALID_TRANSPORT_PUBLIC_KEY',
  );
  await assert.rejects(
    registry.publishServerTransportKey({ ...base, expiresAt: new Date(now() + 5_000).toISOString() }),
    (error) => error.code === 'TRANSPORT_KEY_EXPIRY_TOO_SOON',
  );
  await assert.rejects(
    registry.publishServerTransportKey({ ...base, expiresAt: new Date(now() + 900_000).toISOString() }),
    (error) => error.code === 'TRANSPORT_KEY_LIFETIME_TOO_LONG',
  );
  await assert.rejects(
    registry.publishServerTransportKey({ ...base, algorithm: 'RSA', expiresAt: new Date(now() + 120_000).toISOString() }),
    (error) => error.code === 'UNSUPPORTED_TRANSPORT_KEY_ALGORITHM',
  );
  await assert.rejects(
    registry.publishServerTransportKey({ ...base, serverId: 'missing-shard', expiresAt: new Date(now() + 120_000).toISOString() }),
    (error) => error.code === 'SHARD_NOT_FOUND',
  );
});

test('offline or stale Dedicated Servers cannot publish or serve transport public keys', async () => {
  const { registry, now, advance } = await setup({ heartbeatTtlMs: 1_000 });
  await registry.registerServer(server('transport-shard-c'));
  await registry.heartbeatServer('transport-shard-c', { currentPlayers: 0, status: 'offline' });
  await assert.rejects(
    registry.publishServerTransportKey({
      serverId: 'transport-shard-c', keyId: 'key-offline', publicKey: publicKey(0x44),
      expiresAt: new Date(now() + 120_000).toISOString(),
    }),
    (error) => error.code === 'SHARD_NOT_LIVE',
  );
  assert.equal(await registry.getServerTransportKey({ serverId: 'transport-shard-c' }), null);

  await registry.heartbeatServer('transport-shard-c', { currentPlayers: 0, status: 'ready' });
  await registry.publishServerTransportKey({
    serverId: 'transport-shard-c', keyId: 'key-fresh', publicKey: publicKey(0x55),
    expiresAt: new Date(now() + 120_000).toISOString(),
  });
  advance(1_001);
  assert.equal(await registry.getServerTransportKey({ serverId: 'transport-shard-c' }), null);
});
