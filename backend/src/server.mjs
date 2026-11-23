import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createGameService, RidgeError } from './game-service.mjs';
import { createPostgresGameService } from './postgres-game-service.mjs';
import { createSessionRegistry } from './session-registry.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.RIDGE_HOST ?? '127.0.0.1';
const ENV = process.env.RIDGE_ENV ?? 'development';
const STORAGE = process.env.RIDGE_STORAGE ?? (process.env.DATABASE_URL ? 'postgres' : 'memory');
const GAME_SERVER_TOKEN = process.env.RIDGE_SERVER_EVENT_TOKEN ?? '';
const GATEWAY_TOKEN = process.env.RIDGE_GATEWAY_TOKEN ?? '';

function safeTokenEquals(provided, expected) {
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function requireGameServer(request) {
  if (!GAME_SERVER_TOKEN) {
    throw new RidgeError(503, 'GAME_SERVER_AUTH_NOT_CONFIGURED', 'სათამაშო სერვერის შიდა ავტორიზაცია კონფიგურირებული არ არის.');
  }
  if (!safeTokenEquals(request.headers['x-ridge-server-token'], GAME_SERVER_TOKEN)) {
    throw new RidgeError(403, 'GAME_SERVER_FORBIDDEN', 'შიდა სათამაშო სერვერის ავტორიზაცია ვერ დადასტურდა.');
  }
}

function requireGateway(request) {
  if (!GATEWAY_TOKEN) {
    throw new RidgeError(503, 'GATEWAY_AUTH_NOT_CONFIGURED', 'Session gateway-ის შიდა ავტორიზაცია კონფიგურირებული არ არის.');
  }
  if (!safeTokenEquals(request.headers['x-ridge-gateway-token'], GATEWAY_TOKEN)) {
    throw new RidgeError(403, 'GATEWAY_FORBIDDEN', 'Session gateway-ის ავტორიზაცია ვერ დადასტურდა.');
  }
}

function readJson(request, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new RidgeError(413, 'BODY_TOO_LARGE', 'მოთხოვნა ზედმეტად დიდია.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body) return resolve({});
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new RidgeError(400, 'INVALID_JSON_BODY', 'მოთხოვნის ფორმატი არასწორია.'));
        }
        resolve(parsed);
      } catch {
        reject(new RidgeError(400, 'INVALID_JSON_BODY', 'JSON არასწორია.'));
      }
    });
    request.on('error', reject);
  });
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function requirePlayer(request) {
  if (ENV === 'production') {
    throw new RidgeError(503, 'AUTH_NOT_CONFIGURED', 'Production authentication is not configured.');
  }
  const playerId = request.headers['x-ridge-player-id'];
  if (typeof playerId !== 'string' || !playerId.trim()) {
    throw new RidgeError(401, 'PLAYER_HEADER_REQUIRED', 'Development რეჟიმში მიუთითე x-ridge-player-id header.');
  }
  if (playerId.length > 80) {
    throw new RidgeError(400, 'INVALID_PLAYER_ID', 'მოთამაშის იდენტიფიკატორი ზედმეტად გრძელია.');
  }
  return playerId;
}

async function createStorage() {
  if (STORAGE === 'memory') {
    if (ENV === 'production') throw new Error('Production mode cannot use ephemeral in-memory game storage.');
    const service = createGameService();
    const sessionRegistry = await createSessionRegistry();
    return { service, sessionRegistry, close: async () => {} };
  }
  if (STORAGE !== 'postgres') throw new Error(`Unsupported RIDGE_STORAGE value: ${STORAGE}`);
  if (!process.env.DATABASE_URL) throw new Error('RIDGE_STORAGE=postgres requires DATABASE_URL.');

  const { Pool } = await import('pg');
  const sslRequired = ['require', 'verify-ca', 'verify-full'].includes((process.env.PGSSL ?? '').toLowerCase());
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 7_000,
    ...(sslRequired ? { ssl: { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' } } : {}),
  });
  pool.on('error', (error) => {
    console.error('RIDGE PostgreSQL idle pool error:', error?.message ?? error);
  });
  try {
    const service = await createPostgresGameService({
      pool,
      dedicatedServerId: process.env.RIDGE_DEDICATED_SERVER_ID ?? 'ridge-development-server',
    });
    const sessionRegistry = await createSessionRegistry({ pool });
    return { service, sessionRegistry, close: async () => service.close() };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

async function main() {
  const storage = await createStorage();
  const service = storage.service;
  const sessionRegistry = storage.sessionRegistry;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      if (request.method === 'GET' && url.pathname === '/health') {
        return send(response, 200, {
          ok: true,
          service: 'ridge-foundation-api',
          environment: ENV,
          storage: service.storageMode ?? 'memory-ephemeral',
        });
      }
      if (request.method === 'GET' && url.pathname === '/ready') {
        if (service.healthCheck) await service.healthCheck();
        const sessionRegistryReady = sessionRegistry?.healthCheck ? await sessionRegistry.healthCheck() : false;
        if (!sessionRegistryReady) throw new RidgeError(503, 'SESSION_REGISTRY_NOT_READY', 'Session registry მზად არ არის.');
        return send(response, 200, { ok: true, storage: service.storageMode ?? 'memory-ephemeral', sessionRegistry: true });
      }
      if (request.method === 'GET' && url.pathname === '/v1/world/state') {
        return send(response, 200, await service.getWorldState());
      }

      // Session and shard control plane. Every route is private to trusted game servers.
      if (request.method === 'GET' && url.pathname === '/v1/internal/shards') {
        requireGameServer(request);
        return send(response, 200, { servers: await sessionRegistry.listServers(url.searchParams.get('region')) });
      }

      if (request.method === 'POST' && url.pathname === '/v1/internal/shards/register') {
        requireGameServer(request);
        const body = await readJson(request);
        return send(response, 201, await sessionRegistry.registerServer(body));
      }

      const shardHeartbeatMatch = url.pathname.match(/^\/v1\/internal\/shards\/([A-Za-z0-9._:-]{1,80})\/heartbeat$/);
      if (request.method === 'POST' && shardHeartbeatMatch) {
        requireGameServer(request);
        const body = await readJson(request);
        return send(response, 200, await sessionRegistry.heartbeatServer(shardHeartbeatMatch[1], body));
      }

      const allocateSessionMatch = url.pathname.match(/^\/v1\/internal\/players\/([A-Za-z0-9._:-]{1,80})\/session\/allocate$/);
      if (request.method === 'POST' && allocateSessionMatch) {
        requireGateway(request);
        const body = await readJson(request);
        return send(response, 201, await sessionRegistry.allocatePlayer(allocateSessionMatch[1], body.region ?? 'ge-tbilisi'));
      }

      const issueJoinTicketMatch = url.pathname.match(/^\/v1\/internal\/players\/([A-Za-z0-9._:-]{1,80})\/session\/join-ticket$/);
      if (request.method === 'POST' && issueJoinTicketMatch) {
        requireGateway(request);
        const body = await readJson(request);
        return send(response, 201, await sessionRegistry.issueJoinTicket({
          playerId: issueJoinTicketMatch[1],
          sessionId: body.sessionId,
          serverId: body.serverId,
        }));
      }

      const claimJoinTicketMatch = url.pathname.match(/^\/v1\/internal\/shards\/([A-Za-z0-9._:-]{1,80})\/join\/claim$/);
      if (request.method === 'POST' && claimJoinTicketMatch) {
        requireGameServer(request);
        const body = await readJson(request);
        return send(response, 200, await sessionRegistry.claimJoinTicket({
          serverId: claimJoinTicketMatch[1],
          ticket: body.ticket,
          claimAttemptId: body.claimAttemptId,
        }));
      }

      const releaseSessionMatch = url.pathname.match(/^\/v1\/internal\/shards\/([A-Za-z0-9._:-]{1,80})\/players\/([A-Za-z0-9._:-]{1,80})\/release$/);
      if (request.method === 'POST' && releaseSessionMatch) {
        requireGameServer(request);
        const body = await readJson(request);
        return send(response, 200, await sessionRegistry.releaseSession({
          serverId: releaseSessionMatch[1], playerId: releaseSessionMatch[2], sessionId: body.sessionId,
        }));
      }

      // Internal endpoints are callable only by the trusted Dedicated Server.
      const internalAcceptMatch = url.pathname.match(/^\/v1\/internal\/players\/([A-Za-z0-9._:-]{1,80})\/jobs\/accept$/);
      if (request.method === 'POST' && internalAcceptMatch) {
        requireGameServer(request);
        const body = await readJson(request);
        return send(response, 201, await service.acceptJob(internalAcceptMatch[1], body.definitionId ?? 'delivery_intro'));
      }

      const internalCompleteMatch = url.pathname.match(/^\/v1\/internal\/jobs\/([0-9a-f-]{36})\/complete$/i);
      if (request.method === 'POST' && internalCompleteMatch) {
        requireGameServer(request);
        const body = await readJson(request);
        return send(response, 200, await service.completeJob(body.playerId, internalCompleteMatch[1], body.completionProof));
      }

      const checkpointMatch = url.pathname.match(/^\/v1\/internal\/jobs\/([0-9a-f-]{36})\/checkpoints$/i);
      if (request.method === 'POST' && checkpointMatch) {
        requireGameServer(request);
        const body = await readJson(request);
        return send(response, 200, await service.recordJobCheckpoint(
          body.playerId,
          checkpointMatch[1],
          body.checkpointId,
          body.serverEventId,
          body.observedPosition,
        ));
      }

      const playerId = requirePlayer(request);
      if (request.method === 'GET' && url.pathname === '/v1/player/me') {
        return send(response, 200, await service.getPlayer(playerId));
      }
      if (request.method === 'GET' && url.pathname === '/v1/player/wallet') {
        return send(response, 200, await service.getWallet(playerId));
      }
      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/i);
      if (request.method === 'GET' && jobMatch) {
        return send(response, 200, await service.getJob(playerId, jobMatch[1]));
      }
      if (request.method === 'POST' && url.pathname === '/v1/jobs/accept') {
        const body = await readJson(request);
        return send(response, 201, await service.acceptJob(playerId, body.definitionId ?? 'delivery_intro'));
      }
      const completeMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})\/complete$/i);
      if (request.method === 'POST' && completeMatch) {
        const body = await readJson(request);
        return send(response, 200, await service.completeJob(playerId, completeMatch[1], body.completionProof));
      }

      return send(response, 404, { error: { code: 'ROUTE_NOT_FOUND', message: 'მისამართი ვერ მოიძებნა.' } });
    } catch (error) {
      if (error instanceof RidgeError) {
        return send(response, error.status, { error: { code: error.code, message: error.message } });
      }
      console.error('Unhandled API error:', error?.message ?? error);
      return send(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'შიდა სერვერული შეცდომა.' } });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`RIDGE Foundation API (${ENV}, ${service.storageMode ?? 'memory-ephemeral'}) listening on http://${HOST}:${PORT}`);
  });

  let isClosing = false;
  async function shutdown(signal) {
    if (isClosing) return;
    isClosing = true;
    console.log(`\n${signal}: closing RIDGE API...`);
    server.close(async (error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
      try { await storage.close(); } catch (closeError) {
        console.error('Storage shutdown error:', closeError?.message ?? closeError);
        process.exitCode = 1;
      }
    });
  }
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

main().catch((error) => {
  console.error('RIDGE API startup failed:', error?.message ?? error);
  process.exitCode = 1;
});