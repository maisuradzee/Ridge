import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
const issuer = 'https://ridge-transport-test-identity.example/';
const audience = 'ridge-game-api';
const serverToken = 'ridge-gateway-transport-server-token';

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error('RIDGE API exited before transport test readiness.');
    try { if ((await fetch(baseUrl + '/health')).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('RIDGE API did not become healthy.');
}

function makeToken(privateKey, kid, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: audience, sub: subject, iat: now - 5, exp: now + 180,
  })).toString('base64url');
  const signingInput = header + '.' + payload;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return signingInput + '.' + signature;
}

function rawX25519Public(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  assert.equal(der.length, prefix.length + 32);
  assert.deepEqual(der.subarray(0, prefix.length), prefix);
  return der.subarray(prefix.length).toString('base64url');
}

async function startGateway(t) {
  const jwksPort = await freePort();
  const apiPort = await freePort();
  const baseUrl = 'http://127.0.0.1:' + apiPort;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'ridge-transport-gateway-key';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const jwks = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  jwks.listen(jwksPort, '127.0.0.1');
  await once(jwks, 'listening');

  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(apiPort),
      RIDGE_HOST: '127.0.0.1',
      RIDGE_ENV: 'development',
      RIDGE_STORAGE: 'memory',
      RIDGE_SERVER_EVENT_TOKEN: serverToken,
      RIDGE_OIDC_ISSUER: issuer,
      RIDGE_OIDC_AUDIENCE: audience,
      RIDGE_OIDC_JWKS_URL: 'http://127.0.0.1:' + jwksPort + '/.well-known/jwks.json',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2_000)]);
    }
    await new Promise((resolve) => jwks.close(() => resolve()));
  });
  await waitForHealth(baseUrl, child);
  return { baseUrl, privateKey, kid };
}

async function registerShard(baseUrl, serverId, region) {
  const response = await fetch(baseUrl + '/v1/internal/shards/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ridge-server-token': serverToken },
    body: JSON.stringify({
      serverId, region, host: '127.0.0.1', port: 27777,
      maxPlayers: 8, protocolVersion: 'ridge-0.6',
    }),
  });
  assert.equal(response.status, 201);
}

async function requestSession(baseUrl, privateKey, kid, subject, body) {
  return fetch(baseUrl + '/v1/gateway/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + makeToken(privateKey, kid, subject),
    },
    body: JSON.stringify(body),
  });
}

test('Gateway binds an authenticated client ephemeral key to the allocated shard key and omits plaintext join URL options', async (t) => {
  const { baseUrl, privateKey, kid } = await startGateway(t);
  const serverId = 'gateway-transport-' + Date.now();
  await registerShard(baseUrl, serverId, 'ge-tbilisi');

  const serverPair = generateKeyPairSync('x25519');
  const serverPublicKey = rawX25519Public(serverPair.publicKey);
  const serverKeyId = 'gateway-x25519-' + Date.now();
  const keyResponse = await fetch(baseUrl + '/v1/internal/shards/' + serverId + '/transport-key', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-ridge-server-id': serverId,
      'x-ridge-server-token': serverToken,
    },
    body: JSON.stringify({
      keyId: serverKeyId,
      algorithm: 'X25519',
      publicKey: serverPublicKey,
      expiresAt: new Date(Date.now() + 180_000).toISOString(),
    }),
  });
  assert.equal(keyResponse.status, 201);

  const clientPair = generateKeyPairSync('x25519');
  const clientPublicKey = rawX25519Public(clientPair.publicKey);
  const invalid = await requestSession(baseUrl, privateKey, kid, 'invalid-client-key-subject', {
    region: 'ge-tbilisi',
    clientTransportPublicKey: Buffer.alloc(32).toString('base64url'),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_TRANSPORT_PUBLIC_KEY');

  const response = await requestSession(baseUrl, privateKey, kid, 'invalid-client-key-subject', {
    region: 'ge-tbilisi',
    clientTransportPublicKey: clientPublicKey,
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await response.json();
  assert.equal(session.server.serverId, undefined, 'Public server connection metadata must not add private registry details.');
  assert.equal(session.server.host, '127.0.0.1');
  assert.equal(session.transport.protocolVersion, 1);
  assert.equal(session.transport.suite, 'X25519-HKDF-SHA256-AES-256-GCM');
  assert.equal(session.transport.algorithm, 'X25519');
  assert.equal(session.transport.keyId, serverKeyId);
  assert.equal(session.transport.serverId, serverId);
  assert.equal(session.transport.clientPublicKey, clientPublicKey);
  assert.equal(session.transport.serverPublicKey, serverPublicKey);
  assert.ok(Date.parse(session.transport.expiresAt) >= Date.parse(session.expiresAt));
  assert.equal('connectionOptions' in session, false);
  assert.equal('connectUrl' in session, false);
  assert.equal('ticket' in session.transport, false);
  assert.match(session.join.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal('playerId' in session, false);
  assert.equal('email' in session, false);
});

test('Gateway releases reservation and issues no ticket when an allocated shard has no active transport key', async (t) => {
  const { baseUrl, privateKey, kid } = await startGateway(t);
  const serverId = 'gateway-no-key-' + Date.now();
  await registerShard(baseUrl, serverId, 'ge-batumi');
  const clientPair = generateKeyPairSync('x25519');
  const clientPublicKey = rawX25519Public(clientPair.publicKey);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestSession(baseUrl, privateKey, kid, 'no-key-subject', {
      region: 'ge-batumi',
      clientTransportPublicKey: clientPublicKey,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'TRANSPORT_KEY_NOT_AVAILABLE');
  }

  const shortLivedServerId = 'gateway-short-key-' + Date.now();
  await registerShard(baseUrl, shortLivedServerId, 'ge-kutaisi');
  const shortPair = generateKeyPairSync('x25519');
  const shortKeyResponse = await fetch(baseUrl + '/v1/internal/shards/' + shortLivedServerId + '/transport-key', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-ridge-server-id': shortLivedServerId,
      'x-ridge-server-token': serverToken,
    },
    body: JSON.stringify({
      keyId: 'gateway-short-expiry-' + Date.now(),
      algorithm: 'X25519',
      publicKey: rawX25519Public(shortPair.publicKey),
      // Above the registry's 15-second minimum, but shorter than a 30-second join ticket.
      expiresAt: new Date(Date.now() + 20_000).toISOString(),
    }),
  });
  assert.equal(shortKeyResponse.status, 201);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await requestSession(baseUrl, privateKey, kid, 'short-key-subject', {
      region: 'ge-kutaisi',
      clientTransportPublicKey: clientPublicKey,
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'TRANSPORT_KEY_EXPIRES_BEFORE_JOIN_TICKET');
  }
});
