import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const backendDir = fileURLToPath(new URL('../', import.meta.url));

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function ready(baseUrl, child) {
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error('RIDGE API exited during transport-key HTTP test.');
    try { if ((await fetch(baseUrl + '/health')).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('RIDGE API did not become healthy.');
}

test('server and Provisioner revocation are authenticated and Gateway immediately stops serving revoked keys', async (t) => {
  const port = await freePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const serverToken = 'transport-key-server-token-test-only';
  const gatewayToken = 'transport-key-gateway-token-test-only';
  const provisionerToken = 'transport-key-provisioner-token-test-only';
  const serverId = 'transport-http-shard';
  const provisionerActorId = 'ridge-transport-test-provisioner';
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: {
      ...process.env, PORT: String(port), RIDGE_HOST: '127.0.0.1',
      RIDGE_ENV: 'development', RIDGE_STORAGE: 'memory',
      RIDGE_SERVER_EVENT_TOKEN: serverToken, RIDGE_GATEWAY_TOKEN: gatewayToken,
      RIDGE_SERVER_PROVISIONING_TOKEN: provisionerToken,
      RIDGE_SERVER_PROVISIONING_ACTOR_ID: provisionerActorId,
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2_000)]);
    }
  });
  await ready(baseUrl, child);

  const register = await fetch(baseUrl + '/v1/internal/shards/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ridge-server-token': serverToken },
    body: JSON.stringify({
      serverId, region: 'ge-tbilisi', host: '127.0.0.1', port: 27777,
      maxPlayers: 8, protocolVersion: 'ridge-0.6',
    }),
  });
  assert.equal(register.status, 201);

  const keyUrl = baseUrl + '/v1/internal/shards/' + serverId + '/transport-key';
  const serverHeaders = {
    'content-type': 'application/json',
    'x-ridge-server-id': serverId,
    'x-ridge-server-token': serverToken,
  };
  const gatewayHeaders = { 'x-ridge-gateway-token': gatewayToken };
  const publish = async (keyId, octet) => {
    const response = await fetch(keyUrl, {
      method: 'PUT', headers: serverHeaders,
      body: JSON.stringify({
        keyId, algorithm: 'X25519',
        publicKey: Buffer.alloc(32, octet).toString('base64url'),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      }),
    });
    assert.equal(response.status, 201);
    return response.json();
  };

  const noServerAuth = await fetch(keyUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ keyId: 'untrusted-key', publicKey: Buffer.alloc(32, 0x33).toString('base64url'), expiresAt: new Date(Date.now() + 120_000).toISOString() }),
  });
  assert.equal(noServerAuth.status, 403);

  const first = await publish('http-key-1', 0x66);
  assert.equal(first.privateKey, undefined);
  const noGateway = await fetch(keyUrl);
  assert.equal(noGateway.status, 403);
  const gatewayRead = await fetch(keyUrl, { headers: gatewayHeaders });
  assert.equal(gatewayRead.status, 200);
  assert.equal((await gatewayRead.json()).keyId, 'http-key-1');

  const keyAudit = baseUrl + '/v1/control/shards/' + serverId + '/transport-key-audit';
  const serverRevoke = keyUrl + '/http-key-1/revoke';
  const unauthenticatedRevoke = await fetch(serverRevoke, { method: 'POST' });
  assert.equal(unauthenticatedRevoke.status, 403);
  const revokedByServer = await fetch(serverRevoke, { method: 'POST', headers: serverHeaders });
  assert.equal(revokedByServer.status, 200);
  assert.equal((await revokedByServer.json()).revoked, true);
  const repeatedServerRevoke = await fetch(serverRevoke, { method: 'POST', headers: serverHeaders });
  assert.equal((await repeatedServerRevoke.json()).revoked, false);
  const revokedRead = await fetch(keyUrl, { headers: gatewayHeaders });
  assert.equal(revokedRead.status, 404);

  await publish('http-key-2', 0x77);
  const controlRevoke = baseUrl + '/v1/control/shards/' + serverId + '/transport-key/http-key-2/revoke';
  const unauthenticatedControl = await fetch(controlRevoke, { method: 'POST' });
  assert.equal(unauthenticatedControl.status, 403);
  const revokedByProvisioner = await fetch(controlRevoke, {
    method: 'POST',
    headers: {
      'x-ridge-provisioning-token': provisionerToken,
      'x-ridge-provisioning-actor-id': 'forged-actor-must-be-ignored',
    },
  });
  assert.equal(revokedByProvisioner.status, 200);
  assert.equal((await revokedByProvisioner.json()).revoked, true);

  const unauthenticatedAudit = await fetch(keyAudit);
  assert.equal(unauthenticatedAudit.status, 403);
  const auditResponse = await fetch(keyAudit, {
    headers: {
      'x-ridge-provisioning-token': provisionerToken,
      'x-ridge-provisioning-actor-id': 'forged-actor-must-be-ignored',
    },
  });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json();
  assert.equal(audit.events.length, 4);
  assert.ok(audit.events.some((event) => event.action === 'published' && event.keyId === 'http-key-1' && event.actorId === serverId));
  assert.ok(audit.events.some((event) => event.action === 'revoked' && event.keyId === 'http-key-1' && event.actorType === 'dedicated_server'));
  assert.ok(audit.events.some((event) => event.action === 'published' && event.keyId === 'http-key-2'));
  assert.ok(audit.events.some((event) => event.action === 'revoked' && event.keyId === 'http-key-2' && event.actorType === 'service' && event.actorId === provisionerActorId));
});
