import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const runAgainstPostgres = process.env.RIDGE_RUN_POSTGRES_INTEGRATION === 'YES';

async function getFreePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(baseUrl, child, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error('Production RIDGE API exited before readiness: ' + output());
    }
    try {
      const response = await fetch(baseUrl + '/health');
      if (response.ok) return;
    } catch {
      // The local Production API is still starting against the isolated CI database.
    }
    await delay(100);
  }
  throw new Error('Production RIDGE API did not become healthy: ' + output());
}

test('Production Gateway fails closed over a live PostgreSQL-backed API before OIDC or session allocation', {
  skip: !runAgainstPostgres,
}, async (t) => {
  assert.ok(process.env.DATABASE_URL, 'PostgreSQL integration requires DATABASE_URL.');
  const { Pool } = await import('pg');
  const auditPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 3_000,
  });
  t.after(async () => {
    await auditPool.end();
  });

  const port = await getFreePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      RIDGE_HOST: '127.0.0.1',
      RIDGE_ENV: 'production',
      RIDGE_STORAGE: 'postgres',
      RIDGE_SERVER_PROVISIONING_TOKEN: 'ci-production-transport-smoke-token',
      RIDGE_SERVER_PROVISIONING_ACTOR_ID: 'ridge-ci-production-smoke',
      RIDGE_TRUST_PROXY: 'true',
      RIDGE_OIDC_ISSUER: 'https://identity.example.test/',
      RIDGE_OIDC_AUDIENCE: 'ridge-production-gateway-smoke',
      RIDGE_OIDC_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(2_000)]);
    }
  });

  await waitForHealth(baseUrl, child, () => output);

  const readyResponse = await fetch(baseUrl + '/ready');
  assert.equal(readyResponse.status, 200);
  const ready = await readyResponse.json();
  assert.equal(ready.ok, true);
  assert.equal(ready.sessionRegistry, true);
  assert.deepEqual(ready.gameplayAdmission, {
    status: 'blocked',
    gameSessionsEnabled: false,
    encryptionRuntimeVerified: false,
    reasonCode: 'GAME_TRANSPORT_ENCRYPTION_NOT_READY',
  });

  const counts = async () => {
    const result = await auditPool.query(
      `SELECT count(*)::integer AS sessions,
              count(*) FILTER (WHERE join_ticket_hash IS NOT NULL)::integer AS join_tickets
         FROM ridge.player_sessions`,
    );
    return result.rows[0];
  };
  const before = await counts();

  // No Authorization header is intentional: the transport gate must win over
  // the OIDC missing-token error, proving this is checked first on the live route.
  const gatewayResponse = await fetch(baseUrl + '/v1/gateway/session', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
    },
    body: JSON.stringify({ region: 'ge-tbilisi' }),
  });
  assert.equal(gatewayResponse.status, 503);
  const gatewayBody = await gatewayResponse.json();
  assert.equal(gatewayBody.error.code, 'GAME_TRANSPORT_ENCRYPTION_NOT_READY');

  const after = await counts();
  assert.deepEqual(after, before, 'Blocked Production Gateway must not allocate a session or issue a join ticket.');
});
