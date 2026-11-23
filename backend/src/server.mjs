import http from 'node:http';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { createGameService, RidgeError } from './game-service.mjs';
import { createPostgresGameService } from './postgres-game-service.mjs';
import { createSessionRegistry } from './session-registry.mjs';
import { createOidcVerifier, deriveCanonicalPlayerId } from './oidc-verifier.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.RIDGE_HOST ?? '127.0.0.1';
const ENV = process.env.RIDGE_ENV ?? 'development';
const STORAGE = process.env.RIDGE_STORAGE ?? (process.env.DATABASE_URL ? 'postgres' : 'memory');
const GAME_SERVER_TOKEN = process.env.RIDGE_SERVER_EVENT_TOKEN ?? '';
const GATEWAY_TOKEN = process.env.RIDGE_GATEWAY_TOKEN ?? '';
const SERVER_PROVISIONING_TOKEN = process.env.RIDGE_SERVER_PROVISIONING_TOKEN ?? '';
const TRUST_PROXY = process.env.RIDGE_TRUST_PROXY === 'true';



function isPrivateBindHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim().toLowerCase();
  if (value === 'localhost') return true;

  const family = isIP(value);
  if (family === 4) {
    const octets = value.split('.').map(Number);
    const [a, b] = octets;
    return a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (family === 6) {
    if (value === '::1') return true;
    const firstHextet = Number.parseInt(value.split(':')[0] || '0', 16);
    // IPv6 Unique Local Addresses (fc00::/7). Global and unspecified
    // addresses, including ::, are deliberately rejected for the API listener.
    return Number.isFinite(firstHextet) && (firstHextet & 0xfe00) === 0xfc00;
  }
  return false;
}

function createConfiguredOidcVerifier() {
  const issuer = process.env.RIDGE_OIDC_ISSUER ?? '';
  const audience = process.env.RIDGE_OIDC_AUDIENCE ?? '';
  const jwksUrl = process.env.RIDGE_OIDC_JWKS_URL ?? '';
  const configuredCount = [issuer, audience, jwksUrl].filter(Boolean).length;
  if (configuredCount === 0) {
    if (ENV === 'production') throw new Error('Production RIDGE API requires OIDC issuer, audience and JWKS configuration.');
    return null;
  }
  if (configuredCount !== 3) {
    throw new Error('RIDGE_OIDC_ISSUER, RIDGE_OIDC_AUDIENCE and RIDGE_OIDC_JWKS_URL must be configured together.');
  }
  return createOidcVerifier({
    issuer,
    audience,
    jwksUrl,
    allowHttpForDevelopment: ENV !== 'production',
  });
}

function safeTokenEquals(provided, expected) {
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

async function requireGameServer(request, routeServerId, sessionRegistry) {
  const headerServerId = request.headers['x-ridge-server-id'];
  const serverId = routeServerId ?? headerServerId;
  if (routeServerId && headerServerId && routeServerId !== headerServerId) {
    throw new RidgeError(403, 'GAME_SERVER_ID_MISMATCH', 'Server identity header does not match the route.');
  }

  // The shared role token is a development-only compatibility path.
  if (ENV !== 'production' && GAME_SERVER_TOKEN &&
      safeTokenEquals(request.headers['x-ridge-server-token'], GAME_SERVER_TOKEN)) {
    return;
  }
  if (!serverId || typeof serverId !== 'string') {
    throw new RidgeError(403, 'GAME_SERVER_FORBIDDEN', 'Dedicated Server instance identity is required.');
  }
  const authenticated = await sessionRegistry.authenticateServerCredential({
    serverId,
    token: request.headers['x-ridge-server-token'],
  });
  if (!authenticated) {
    throw new RidgeError(403, 'GAME_SERVER_FORBIDDEN', 'Per-instance Dedicated Server credential is invalid, expired or revoked.');
  }
}

function requireServerProvisioner(request) {
  if (!SERVER_PROVISIONING_TOKEN) {
    if (ENV !== 'production' && GAME_SERVER_TOKEN &&
        safeTokenEquals(request.headers['x-ridge-server-token'], GAME_SERVER_TOKEN)) {
      return;
    }
    throw new RidgeError(403, 'SERVER_PROVISIONING_FORBIDDEN', 'Server provisioning authorization failed.');
  }
  if (!safeTokenEquals(request.headers['x-ridge-provisioning-token'], SERVER_PROVISIONING_TOKEN)) {
    throw new RidgeError(403, 'SERVER_PROVISIONING_FORBIDDEN', 'Server provisioning authorization failed.');
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
  if (ENV === 'production' && !isPrivateBindHost(HOST)) {
    throw new Error('Production RIDGE API must bind to loopback or a private network IP; public and wildcard listeners are forbidden.');
  }
  if (ENV === 'production' && STORAGE === 'memory') {
    throw new Error('Production mode cannot use ephemeral in-memory game storage.');
  }
  if (ENV === 'production' && !SERVER_PROVISIONING_TOKEN) {
    throw new Error('Production RIDGE API requires RIDGE_SERVER_PROVISIONING_TOKEN for per-instance credential rotation.');
  }
  if (ENV === 'production' && !TRUST_PROXY) {
    throw new Error('Production RIDGE public gateway requires a trusted HTTPS reverse proxy (RIDGE_TRUST_PROXY=true).');
  }
  const oidcVerifier = createConfiguredOidcVerifier();
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
      // Public player session entry. Identity is derived only from a verified OIDC JWT.
      if (request.method === 'POST' && url.pathname === '/v1/gateway/session') {
        if (!oidcVerifier) {
          throw new RidgeError(503, 'OIDC_NOT_CONFIGURED', 'RIDGE account identity provider ჯერ არ არის კონფიგურირებული.');
        }
        const forwardedProto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
        const secureTransport = Boolean(request.socket.encrypted) || (TRUST_PROXY && forwardedProto === 'https');
        if (ENV === 'production' && !secureTransport) {
          throw new RidgeError(400, 'HTTPS_REQUIRED', 'Gateway-ის public session endpoint მხოლოდ HTTPS-ით არის ხელმისაწვდომი.');
        }

        let identity;
        try {
          identity = await oidcVerifier.verifyAuthorizationHeader(request.headers.authorization);
        } catch (error) {
          const unavailable = ['OIDC_JWKS_UNAVAILABLE', 'OIDC_JWKS_INVALID'].includes(error?.code);
          throw new RidgeError(
            unavailable ? 503 : 401,
            unavailable ? 'OIDC_IDENTITY_SERVICE_UNAVAILABLE' : 'OIDC_TOKEN_INVALID',
            unavailable ? 'Identity provider-ის signing keys დროებით მიუწვდომელია.' : 'ანგარიშის ავტორიზაცია ვერ დადასტურდა.',
          );
        }

        const body = await readJson(request, 4 * 1024);
        const playerId = deriveCanonicalPlayerId(identity.issuer, identity.subject);
        const allocation = await sessionRegistry.allocatePlayer(playerId, body.region ?? 'ge-tbilisi');
        if (allocation.status !== 'allocated') {
          throw new RidgeError(409, 'PLAYER_SESSION_ALREADY_CONNECTED', 'ამ ანგარიშს უკვე აქვს აქტიური თამაშის კავშირი.');
        }

        let issued;
        try {
          issued = await sessionRegistry.issueJoinTicket({
            playerId,
            sessionId: allocation.sessionId,
            serverId: allocation.server.serverId,
          });
        } catch (error) {
          if (!allocation.reused) {
            await sessionRegistry.releaseSession({
              playerId,
              sessionId: allocation.sessionId,
              serverId: allocation.server.serverId,
            }).catch(() => {});
          }
          throw error;
        }

        const encodedTicket = encodeURIComponent(issued.ticket);
        const encodedAttempt = encodeURIComponent(issued.claimAttemptId);
        const connectionOptions = 'ridgeJoinTicket=' + encodedTicket +
          '?ridgeClaimAttemptId=' + encodedAttempt;
        const connectUrl = issued.server.host + ':' + issued.server.port + '?' + connectionOptions;

        return send(response, 201, {
          sessionId: issued.sessionId,
          expiresAt: issued.expiresAt,
          server: {
            host: issued.server.host,
            port: issued.server.port,
            region: issued.server.region,
            protocolVersion: issued.server.protocolVersion,
          },
          join: {
            ticket: issued.ticket,
            claimAttemptId: issued.claimAttemptId,
          },
          connectionOptions,
          connectUrl,
        });
      }

      if (request.method === 'GET' && url.pathname === '/v1/world/state') {
        return send(response, 200, await service.getWorldState());
      }

      // Control-plane credential issuance is restricted to the deployment orchestrator.
      const serverCredentialMatch = url.pathname.match(/^\/v1\/control\/shards\/([A-Za-z0-9._:-]{1,80})\/credentials$/);
      if (request.method === 'POST' && serverCredentialMatch) {
        requireServerProvisioner(request);
        const credential = await sessionRegistry.issueServerCredential({ serverId: serverCredentialMatch[1] });
        return send(response, 201, credential);
      }

      const revokeServerCredentialMatch = url.pathname.match(/^\/v1\/control\/shards\/([A-Za-z0-9._:-]{1,80})\/credentials\/revoke$/);
      if (request.method === 'POST' && revokeServerCredentialMatch) {
        requireServerProvisioner(request);
        return send(response, 200, await sessionRegistry.revokeServerCredential({ serverId: revokeServerCredentialMatch[1] }));
      }

      // Session and shard control plane. Production requires per-instance credentials.
      if (request.method === 'GET' && url.pathname === '/v1/internal/shards') {
        requireServerProvisioner(request);
        return send(response, 200, { servers: await sessionRegistry.listServers(url.searchParams.get('region')) });
      }

      if (request.method === 'POST' && url.pathname === '/v1/internal/shards/register') {
        const body = await readJson(request);
        await requireGameServer(request, body.serverId, sessionRegistry);
        return send(response, 201, await sessionRegistry.registerServer(body));
      }

      const shardHeartbeatMatch = url.pathname.match(/^\/v1\/internal\/shards\/([A-Za-z0-9._:-]{1,80})\/heartbeat$/);
      if (request.method === 'POST' && shardHeartbeatMatch) {
        await requireGameServer(request, shardHeartbeatMatch[1], sessionRegistry);
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
        await requireGameServer(request, claimJoinTicketMatch[1], sessionRegistry);
        const body = await readJson(request);
        return send(response, 200, await sessionRegistry.claimJoinTicket({
          serverId: claimJoinTicketMatch[1],
          ticket: body.ticket,
          claimAttemptId: body.claimAttemptId,
        }));
      }

      const releaseSessionMatch = url.pathname.match(/^\/v1\/internal\/shards\/([A-Za-z0-9._:-]{1,80})\/players\/([A-Za-z0-9._:-]{1,80})\/release$/);
      if (request.method === 'POST' && releaseSessionMatch) {
        await requireGameServer(request, releaseSessionMatch[1], sessionRegistry);
        const body = await readJson(request);
        return send(response, 200, await sessionRegistry.releaseSession({
          serverId: releaseSessionMatch[1], playerId: releaseSessionMatch[2], sessionId: body.sessionId,
        }));
      }

      // Internal endpoints are callable only by the trusted Dedicated Server.
      const internalAcceptMatch = url.pathname.match(/^\/v1\/internal\/players\/([A-Za-z0-9._:-]{1,80})\/jobs\/accept$/);
      if (request.method === 'POST' && internalAcceptMatch) {
        await requireGameServer(request, request.headers['x-ridge-server-id'], sessionRegistry);
        const body = await readJson(request);
        return send(response, 201, await service.acceptJob(internalAcceptMatch[1], body.definitionId ?? 'delivery_intro'));
      }

      const internalCompleteMatch = url.pathname.match(/^\/v1\/internal\/jobs\/([0-9a-f-]{36})\/complete$/i);
      if (request.method === 'POST' && internalCompleteMatch) {
        await requireGameServer(request, request.headers['x-ridge-server-id'], sessionRegistry);
        const body = await readJson(request);
        return send(response, 200, await service.completeJob(body.playerId, internalCompleteMatch[1], body.completionProof));
      }

      const checkpointMatch = url.pathname.match(/^\/v1\/internal\/jobs\/([0-9a-f-]{36})\/checkpoints$/i);
      if (request.method === 'POST' && checkpointMatch) {
        await requireGameServer(request, request.headers['x-ridge-server-id'], sessionRegistry);
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