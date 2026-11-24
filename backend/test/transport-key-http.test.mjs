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

test('server-authenticated transport key publication and Gateway-only public-key retrieval', async (t) => {
  const port = await freePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const serverToken = 'transport-key-server-token-test-only';
  const gatewayToken = 'transport-key-gateway-token-test-only';
  const serverId = 'transport-http-shard';
  const publicKey = Buffer.alloc(32, 0x66).toString('base64url');
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: {
      ...process.env, PORT: String(port), RIDGE_HOST: '127.0.0.1',
      RIDGE_ENV: 'development', RIDGE_STORAGE: 'memory',
      RIDGE_SERVER_EVENT_TOKEN: serverToken, RIDGE_GATEWAY_TOKEN: gatewayToken,
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
  const payload = JSON.stringify({ keyId: 'http-key-1', algorithm: 'X25519', publicKey, expiresAt });
  const untrusted = await fetch(keyUrl, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: payload });
  assert.equal(untrusted.status, 403);

  const published = await fetch(keyUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-ridge-server-id': serverId, 'x-ridge-server-token': serverToken },
    body: payload,
  });
  assert.equal(published.status, 201);
  const publishedBody = await published.json();
  assert.equal(publishedBody.keyId, 'http-key-1');
  assert.equal(publishedBody.publicKey, publicKey);
  assert.equal('privateKey' in publishedBody, false);

  const noGateway = await fetch(keyUrl);
  assert.equal(noGateway.status, 403);
  const wrongGateway = await fetch(keyUrl, { headers: { 'x-ridge-gateway-token': 'wrong' } });
  assert.equal(wrongGateway.status, 403);
  const gatewayRead = await fetch(keyUrl, { headers: { 'x-ridge-gateway-token': gatewayToken } });
  assert.equal(gatewayRead.status, 200);
  assert.equal((await gatewayRead.json()).keyId, 'http-key-1');
});
