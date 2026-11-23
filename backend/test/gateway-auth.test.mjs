import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
const issuer = 'https://ridge-test-identity.example/';
const audience = 'ridge-game-api';
const serverToken = 'ridge-development-server-internal-token';

async function getFreePort() {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error('RIDGE API exited before health became ready.');
    try {
      const response = await fetch(baseUrl + '/health');
      if (response.ok) return;
    } catch {
      // The child process may still be binding its listener.
    }
    await delay(100);
  }
  throw new Error('RIDGE API did not become healthy in time.');
}

function makeIdentityToken(privateKey, kid, overrides = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuer,
    aud: audience,
    sub: 'stable-subject-123',
    iat: now - 5,
    exp: now + 180,
    ...overrides,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = encodedHeader + '.' + encodedPayload;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
  return signingInput + '.' + signature;
}

test('public OIDC gateway allocates a shard, issues a stable join ticket and denies a second active login', async (t) => {
  const jwksPort = await getFreePort();
  const apiPort = await getFreePort();
  const baseUrl = 'http://127.0.0.1:' + apiPort;
  const serverId = 'gateway-it-shard-' + Date.now();
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const exported = publicKey.export({ format: 'jwk' });
  const kid = 'ridge-integration-key';
  const jwk = { ...exported, kid, use: 'sig', alg: 'RS256' };

  const jwksServer = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  jwksServer.listen(jwksPort, '127.0.0.1');
  await once(jwksServer, 'listening');

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
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2_000)]);
    }
    await new Promise((resolve) => jwksServer.close(() => resolve()));
  });

  await waitForHealth(baseUrl, child);

  const registration = await fetch(baseUrl + '/v1/internal/shards/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ridge-server-token': serverToken,
    },
    body: JSON.stringify({
      serverId,
      region: 'ge-tbilisi',
      host: '127.0.0.1',
      port: 7777,
      maxPlayers: 8,
      protocolVersion: 'ridge-0.6',
    }),
  });
  assert.equal(registration.status, 201);

  const gatewayUrl = baseUrl + '/v1/gateway/session';
  const unauthorized = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ region: 'ge-tbilisi' }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, 'OIDC_TOKEN_INVALID');

  const wrongAudience = makeIdentityToken(privateKey, kid, { aud: 'not-ridge' });
  const rejected = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + wrongAudience },
    body: JSON.stringify({ region: 'ge-tbilisi' }),
  });
  assert.equal(rejected.status, 401);

  const token = makeIdentityToken(privateKey, kid, { email: 'private@example.test' });
  // Two overlapping requests for one account must not replace the first join ticket.
  const createSessionRequest = () => fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ region: 'ge-tbilisi' }),
  });
  const [firstResponse, parallelResponse] = await Promise.all([
    createSessionRequest(),
    createSessionRequest(),
  ]);
  assert.deepEqual(
    [firstResponse.status, parallelResponse.status].sort((a, b) => a - b),
    [201, 409],
    'Exactly one concurrent login may issue a join ticket.',
  );
  const successfulResponse = firstResponse.status === 201 ? firstResponse : parallelResponse;
  const rejectedResponse = firstResponse.status === 409 ? firstResponse : parallelResponse;
  assert.equal(successfulResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await rejectedResponse.json()).error.code, 'PLAYER_SESSION_LOGIN_PENDING');
  const first = await successfulResponse.json();
  assert.equal(first.server.host, '127.0.0.1');
  assert.equal(first.server.port, 7777);
  assert.equal(first.server.protocolVersion, 'ridge-0.6');
  assert.match(first.join.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.join.claimAttemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.ok(first.connectionOptions.includes('ridgeJoinTicket=' + first.join.ticket));
  assert.ok(first.connectionOptions.includes('ridgeClaimAttemptId=' + first.join.claimAttemptId));
  assert.ok(first.connectUrl.startsWith('127.0.0.1:7777?'));
  assert.equal('playerId' in first, false, 'Canonical backend player ID must not be returned to the client.');
  assert.equal('email' in first, false, 'Identity-provider PII must not be returned to the client.');

  const claimUrl = baseUrl + '/v1/internal/shards/' + serverId + '/join/claim';
  const claim = await fetch(claimUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ridge-server-token': serverToken,
    },
    body: JSON.stringify({
      ticket: first.join.ticket,
      claimAttemptId: first.join.claimAttemptId,
    }),
  });
  assert.equal(claim.status, 200);
  const claimed = await claim.json();
  assert.equal(claimed.connected, true);
  assert.equal(claimed.serverId, serverId);

  const duplicateLogin = await fetch(gatewayUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ region: 'ge-tbilisi' }),
  });
  assert.equal(duplicateLogin.status, 409);
  assert.equal((await duplicateLogin.json()).error.code, 'PLAYER_SESSION_ALREADY_CONNECTED');
});
