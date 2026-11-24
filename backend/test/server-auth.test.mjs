import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

async function getFreePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`RIDGE API exited early: ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await delay(50);
  }
  throw new Error('RIDGE API did not become healthy in time.');
}

test('internal checkpoint endpoint rejects untrusted clients', async (t) => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = 'local-test-server-token-only';
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(port), RIDGE_ENV: 'development', RIDGE_STORAGE: 'memory', RIDGE_SERVER_EVENT_TOKEN: token },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(1500)]);
    }
  });

  await waitForHealth(baseUrl, child);
  const endpoint = `${baseUrl}/v1/internal/jobs/00000000-0000-0000-0000-000000000000/checkpoints`;
  const body = JSON.stringify({ playerId: 'player-1', checkpointId: 'warehouse_pickup', serverEventId: 'event-http-000001' });

  const missing = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).error.code, 'GAME_SERVER_FORBIDDEN');

  const incorrect = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ridge-server-token': 'wrong-token' },
    body,
  });
  assert.equal(incorrect.status, 403);

  const trustedButUnknownJob = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ridge-server-token': token },
    body,
  });
  assert.equal(trustedButUnknownJob.status, 404);
  assert.equal((await trustedButUnknownJob.json()).error.code, 'JOB_NOT_FOUND');
});

test('trusted dedicated-server HTTP flow accepts a delivery, records checkpoints and pays once', async (t) => {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = 'local-e2e-server-token-only';
  const playerId = 'player-http-e2e';
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(port), RIDGE_ENV: 'development', RIDGE_STORAGE: 'memory', RIDGE_SERVER_EVENT_TOKEN: token },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(1500)]);
    }
  });
  await waitForHealth(baseUrl, child);

  const serverHeaders = { 'content-type': 'application/json', 'x-ridge-server-token': token };
  const acceptUrl = `${baseUrl}/v1/internal/players/${playerId}/jobs/accept`;
  const rejectedAccept = await fetch(acceptUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definitionId: 'delivery_intro' }),
  });
  assert.equal(rejectedAccept.status, 403);

  const acceptedResponse = await fetch(acceptUrl, {
    method: 'POST', headers: serverHeaders, body: JSON.stringify({ definitionId: 'delivery_intro' }),
  });
  assert.equal(acceptedResponse.status, 201);
  const accepted = await acceptedResponse.json();
  assert.equal(typeof accepted.completionProof, 'string');
  assert.equal(accepted.requiredCheckpoints.length, 2);

  const sendCheckpoint = (checkpointId, serverEventId) => fetch(`${baseUrl}/v1/internal/jobs/${accepted.id}/checkpoints`, {
    method: 'POST', headers: serverHeaders,
    body: JSON.stringify({ playerId, checkpointId, serverEventId }),
  });

  const outOfOrder = await sendCheckpoint('delivery_dropoff', 'server01:dropoff:beforepickup');
  assert.equal(outOfOrder.status, 409);
  assert.equal((await outOfOrder.json()).error.code, 'CHECKPOINT_OUT_OF_ORDER');

  const pickup = await sendCheckpoint('warehouse_pickup', 'server01:pickup:000001');
  assert.equal(pickup.status, 200);
  assert.equal((await pickup.json()).completedCount, 1);

  const duplicatePickup = await sendCheckpoint('warehouse_pickup', 'server01:pickup:000001');
  assert.equal((await duplicatePickup.json()).replayed, true);

  const dropoff = await sendCheckpoint('delivery_dropoff', 'server01:dropoff:000001');
  assert.equal(dropoff.status, 200);
  assert.equal((await dropoff.json()).completedCount, 2);

  // Completion proof is kept on the dedicated server side; the client never calls this route.
  await delay(1_600);
  const completeUrl = `${baseUrl}/v1/internal/jobs/${accepted.id}/complete`;
  const completionBody = JSON.stringify({ playerId, completionProof: accepted.completionProof });
  const untrustedComplete = await fetch(completeUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: completionBody,
  });
  assert.equal(untrustedComplete.status, 403);
  const complete = async () => fetch(completeUrl, {
    method: 'POST', headers: serverHeaders, body: completionBody,
  });
  const firstPayment = await complete();
  assert.equal(firstPayment.status, 200);
  const firstPaymentBody = await firstPayment.json();
  assert.equal(firstPaymentBody.reward, '15.00');
  assert.equal(firstPaymentBody.replayed, false);

  const replayPayment = await complete();
  const replayPaymentBody = await replayPayment.json();
  assert.equal(replayPaymentBody.replayed, true);
  assert.equal(replayPaymentBody.transactionId, firstPaymentBody.transactionId);

  // Dev wallet endpoint remains available for test inspection only.
  const wallet = await fetch(`${baseUrl}/v1/player/wallet`, { headers: { 'x-ridge-player-id': playerId } });
  assert.equal((await wallet.json()).balance, '15.00');
});

test('production requires a trusted server-provisioning service-principal ID', async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      RIDGE_ENV: 'production',
      RIDGE_STORAGE: 'postgres',
      RIDGE_HOST: '127.0.0.1',
      RIDGE_SERVER_PROVISIONING_TOKEN: 'production-test-provisioner-secret',
      RIDGE_SERVER_PROVISIONING_ACTOR_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output, /requires RIDGE_SERVER_PROVISIONING_ACTOR_ID/);
});

test('production mode refuses to start with ephemeral in-memory storage', async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(port), RIDGE_ENV: 'production', RIDGE_STORAGE: 'memory' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(output, /Production mode cannot use ephemeral in-memory game storage/);
});

test('production API refuses wildcard and public listener addresses before startup', async () => {
  const attempts = [
    { host: '0.0.0.0', expected: /must bind to loopback or a private network IP/ },
    { host: '8.8.8.8', expected: /must bind to loopback or a private network IP/ },
    { host: '10.20.30.40', expected: /Production mode cannot use ephemeral in-memory game storage/ },
    { host: '127.0.0.1', expected: /Production mode cannot use ephemeral in-memory game storage/ },
  ];

  for (const attempt of attempts) {
    const port = await getFreePort();
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(port),
        RIDGE_ENV: 'production',
        RIDGE_STORAGE: 'memory',
        RIDGE_HOST: attempt.host,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, 'Production startup must stop for RIDGE_HOST=' + attempt.host);
    assert.match(output, attempt.expected, 'Unexpected startup guard for RIDGE_HOST=' + attempt.host);
  }
});

test('trusted gateway issues one-time join tickets and only the assigned shard can claim them', async (t) => {
  const port = await getFreePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const token = 'local-test-join-ticket-token';
  const serverId = 'shard-join-' + Date.now();
  const playerId = 'player-join-http';
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: { ...process.env, PORT: String(port), RIDGE_ENV: 'development', RIDGE_STORAGE: 'memory', RIDGE_SERVER_EVENT_TOKEN: token, RIDGE_GATEWAY_TOKEN: 'local-test-gateway-token' },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(1500)]);
    }
  });
  await waitForHealth(baseUrl, child);

  const serverHeaders = { 'content-type': 'application/json', 'x-ridge-server-token': token };
  const gatewayHeaders = { 'content-type': 'application/json', 'x-ridge-gateway-token': 'local-test-gateway-token' };
  const registerUrl = baseUrl + '/v1/internal/shards/register';
  const registerBody = JSON.stringify({
    serverId,
    region: 'ge-tbilisi',
    host: '127.0.0.1',
    port: 24567,
    maxPlayers: 2,
    protocolVersion: 'ridge-0.6',
  });

  const unauthorizedRegister = await fetch(registerUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: registerBody,
  });
  assert.equal(unauthorizedRegister.status, 403);

  const gatewayCannotRegister = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ridge-gateway-token': 'local-test-gateway-token' },
    body: registerBody,
  });
  assert.equal(gatewayCannotRegister.status, 403);

  const registered = await fetch(registerUrl, { method: 'POST', headers: serverHeaders, body: registerBody });
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).serverId, serverId);

  const serverCannotAllocate = await fetch(
    baseUrl + '/v1/internal/players/' + playerId + '/session/allocate',
    { method: 'POST', headers: serverHeaders, body: JSON.stringify({ region: 'ge-tbilisi' }) },
  );
  assert.equal(serverCannotAllocate.status, 403);

  const noAuthList = await fetch(baseUrl + '/v1/internal/shards');
  assert.equal(noAuthList.status, 403);
  const list = await fetch(baseUrl + '/v1/internal/shards?region=ge-tbilisi', { headers: serverHeaders });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).servers.length, 1);

  const allocationResponse = await fetch(
    baseUrl + '/v1/internal/players/' + playerId + '/session/allocate',
    { method: 'POST', headers: gatewayHeaders, body: JSON.stringify({ region: 'ge-tbilisi' }) },
  );
  assert.equal(allocationResponse.status, 201);
  const allocation = await allocationResponse.json();
  assert.equal(allocation.server.serverId, serverId);
  assert.equal(allocation.status, 'allocated');

  const issueUrl = baseUrl + '/v1/internal/players/' + playerId + '/session/join-ticket';
  const issueBody = JSON.stringify({ sessionId: allocation.sessionId, serverId });
  const unauthorizedIssue = await fetch(issueUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: issueBody,
  });
  assert.equal(unauthorizedIssue.status, 403);

  const issuedResponse = await fetch(issueUrl, { method: 'POST', headers: gatewayHeaders, body: issueBody });
  assert.equal(issuedResponse.status, 201);
  const issued = await issuedResponse.json();
  assert.equal(issued.sessionId, allocation.sessionId);
  assert.equal(issued.server.serverId, serverId);
  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.match(issued.claimAttemptId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const claimAttemptId = issued.claimAttemptId;

  const serverCannotIssue = await fetch(issueUrl, {
    method: 'POST', headers: serverHeaders, body: issueBody,
  });
  assert.equal(serverCannotIssue.status, 403);

  const legacyClaimUrl = baseUrl + '/v1/internal/shards/' + serverId + '/players/' + playerId + '/claim';
  const legacyClaim = await fetch(legacyClaimUrl, {
    method: 'POST',
    headers: { ...serverHeaders, 'x-ridge-player-id': 'legacy-route-probe' },
    body: JSON.stringify({ sessionId: allocation.sessionId }),
  });
  assert.equal(legacyClaim.status, 404);

  const wrongShardClaim = await fetch(baseUrl + '/v1/internal/shards/another-shard/join/claim', {
    method: 'POST',
    headers: serverHeaders,
    body: JSON.stringify({ ticket: issued.ticket, claimAttemptId }),
  });
  assert.equal(wrongShardClaim.status, 403);
  assert.equal((await wrongShardClaim.json()).error.code, 'JOIN_TICKET_INVALID');

  const claimUrl = baseUrl + '/v1/internal/shards/' + serverId + '/join/claim';

  const gatewayCannotClaim = await fetch(claimUrl, {
    method: 'POST',
    headers: gatewayHeaders,
    body: JSON.stringify({ ticket: issued.ticket, claimAttemptId }),
  });
  assert.equal(gatewayCannotClaim.status, 403);
  const noAuthClaim = await fetch(claimUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: issued.ticket, claimAttemptId }),
  });
  assert.equal(noAuthClaim.status, 403);

  const claim = await fetch(claimUrl, {
    method: 'POST', headers: serverHeaders,
    body: JSON.stringify({ ticket: issued.ticket, claimAttemptId }),
  });
  assert.equal(claim.status, 200);
  const claimed = await claim.json();
  assert.equal(claimed.playerId, playerId);
  assert.equal(claimed.sessionId, allocation.sessionId);
  assert.equal(claimed.connected, true);
  assert.equal(claimed.replayed, false);

  const replay = await fetch(claimUrl, {
    method: 'POST', headers: serverHeaders,
    body: JSON.stringify({ ticket: issued.ticket, claimAttemptId }),
  });
  assert.equal((await replay.json()).replayed, true);

  const stolenReplay = await fetch(claimUrl, {
    method: 'POST', headers: serverHeaders,
    body: JSON.stringify({ ticket: issued.ticket, claimAttemptId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
  });
  assert.equal(stolenReplay.status, 409);
  assert.equal((await stolenReplay.json()).error.code, 'JOIN_TICKET_ALREADY_USED');

  const heartbeat = await fetch(baseUrl + '/v1/internal/shards/' + serverId + '/heartbeat', {
    method: 'POST', headers: serverHeaders, body: JSON.stringify({ currentPlayers: 1, status: 'ready' }),
  });
  assert.equal(heartbeat.status, 200);
  assert.equal((await heartbeat.json()).currentPlayers, 1);

  const release = await fetch(
    baseUrl + '/v1/internal/shards/' + serverId + '/players/' + playerId + '/release',
    { method: 'POST', headers: serverHeaders, body: JSON.stringify({ sessionId: allocation.sessionId }) },
  );
  assert.equal(release.status, 200);
  assert.equal((await release.json()).released, true);
});


test('per-instance server credential is isolated, rotated and revoked by the provisioner', async (t) => {
  const port = await getFreePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const provisioningToken = 'local-test-provisioning-control-token';
  const serverId = 'shard-credential-' + Date.now();
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(port),
      RIDGE_ENV: 'development',
      RIDGE_STORAGE: 'memory',
      RIDGE_SERVER_PROVISIONING_TOKEN: provisioningToken,
      RIDGE_SERVER_PROVISIONING_ACTOR_ID: 'ridge-test-orchestrator',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(1500)]);
    }
  });
  await waitForHealth(baseUrl, child);

  const credentialUrl = baseUrl + '/v1/control/shards/' + serverId + '/credentials';
  const unauthenticatedProvision = await fetch(credentialUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(unauthenticatedProvision.status, 403);

  const provisionHeaders = {
    'content-type': 'application/json',
    'x-ridge-provisioning-token': provisioningToken,
  };
  const firstResponse = await fetch(credentialUrl, { method: 'POST', headers: provisionHeaders });
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.serverId, serverId);

  const serverHeaders = {
    'content-type': 'application/json',
    'x-ridge-server-id': serverId,
    'x-ridge-server-token': first.token,
  };
  const registerUrl = baseUrl + '/v1/internal/shards/register';
  const registrationBody = JSON.stringify({
    serverId,
    region: 'ge-tbilisi',
    host: '127.0.0.1',
    port: 28777,
    maxPlayers: 8,
    protocolVersion: 'ridge-0.6',
  });
  const registration = await fetch(registerUrl, {
    method: 'POST',
    headers: serverHeaders,
    body: registrationBody,
  });
  assert.equal(registration.status, 201);

  const heartbeatUrl = baseUrl + '/v1/internal/shards/' + serverId + '/heartbeat';
  const firstHeartbeat = await fetch(heartbeatUrl, {
    method: 'POST',
    headers: serverHeaders,
    body: JSON.stringify({ currentPlayers: 0, status: 'ready' }),
  });
  assert.equal(firstHeartbeat.status, 200);

  const secondResponse = await fetch(credentialUrl, { method: 'POST', headers: provisionHeaders });
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json();
  assert.notEqual(second.token, first.token);

  const oldCredential = await fetch(heartbeatUrl, {
    method: 'POST',
    headers: serverHeaders,
    body: JSON.stringify({ currentPlayers: 0, status: 'ready' }),
  });
  assert.equal(oldCredential.status, 403);

  const secondHeaders = { ...serverHeaders, 'x-ridge-server-token': second.token };
  const newCredential = await fetch(heartbeatUrl, {
    method: 'POST',
    headers: secondHeaders,
    body: JSON.stringify({ currentPlayers: 0, status: 'ready' }),
  });
  assert.equal(newCredential.status, 200);

  const wrongInstance = await fetch(heartbeatUrl, {
    method: 'POST',
    headers: { ...secondHeaders, 'x-ridge-server-id': 'another-shard' },
    body: JSON.stringify({ currentPlayers: 0, status: 'ready' }),
  });
  assert.equal(wrongInstance.status, 403);

  const revokeUrl = credentialUrl + '/revoke';
  const revoke = await fetch(revokeUrl, { method: 'POST', headers: provisionHeaders });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).revoked, true);
  const afterRevoke = await fetch(heartbeatUrl, {
    method: 'POST',
    headers: secondHeaders,
    body: JSON.stringify({ currentPlayers: 0, status: 'ready' }),
  });
  assert.equal(afterRevoke.status, 403);

  const auditUrl = credentialUrl + '/audit';
  const unauthenticatedAudit = await fetch(auditUrl);
  assert.equal(unauthenticatedAudit.status, 403);

  const auditResponse = await fetch(auditUrl, {
    headers: { ...provisionHeaders, 'x-ridge-provisioning-actor-id': 'forged-client-actor' },
  });
  assert.equal(auditResponse.status, 200);
  const audit = await auditResponse.json();
  assert.equal(audit.serverId, serverId);
  assert.deepEqual(audit.events.map((event) => event.action), ['revoked', 'rotated', 'issued']);
  assert.ok(audit.events.every((event) =>
    event.actorType === 'service' &&
    event.actorId === 'ridge-test-orchestrator' &&
    !Object.hasOwn(event, 'token') && !Object.hasOwn(event, 'tokenHash')
  ));

  const invalidLimit = await fetch(auditUrl + '?limit=1000', { headers: provisionHeaders });
  assert.equal(invalidLimit.status, 400);
  assert.equal((await invalidLimit.json()).error.code, 'INVALID_CREDENTIAL_AUDIT_LIMIT');
});
