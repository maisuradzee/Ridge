import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RidgeError } from './game-service.mjs';

const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_HEARTBEAT_TTL_MS = 45_000;
const DEFAULT_JOIN_TICKET_MS = 30_000;
const DEFAULT_SERVER_CREDENTIAL_MS = 90 * 24 * 60 * 60 * 1000;
const SERVER_STATUSES = new Set(['ready', 'draining', 'offline']);
const ACTIVE_SESSION_STATUSES = new Set(['allocated', 'connected']);

function fail(status, code, message) {
  throw new RidgeError(status, code, message);
}

function validIdentifier(value, label, maxLength = 80) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.length > maxLength) {
    fail(400, 'INVALID_' + label.toUpperCase(), label + ' არასწორია.');
  }
  return value;
}

function hashServerCredential(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return null;
  }
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function secureHashEquals(providedHash, storedHash) {
  if (typeof providedHash !== 'string' || typeof storedHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(providedHash) || !/^[a-f0-9]{64}$/.test(storedHash)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(providedHash, 'hex'), Buffer.from(storedHash, 'hex'));
}

function hashJoinTicket(ticket) {
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    fail(400, 'INVALID_JOIN_TICKET', 'Join ticket არასწორია.');
  }
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

function validateClaimAttemptId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    fail(400, 'INVALID_CLAIM_ATTEMPT_ID', 'Claim attempt ID არასწორია.');
  }
  return value.toLowerCase();
}

function validateRegistration(input = {}) {
  const serverId = validIdentifier(input.serverId, 'server_id');
  const region = validIdentifier(input.region, 'region', 64).toLowerCase();
  const host = input.host;
  if (typeof host !== 'string' || host.length > 253 ||
      !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host) ||
      host.includes('..') || host.includes('/')) {
    fail(400, 'INVALID_SHARD_HOST', 'Shard host არასწორია.');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    fail(400, 'INVALID_SHARD_PORT', 'Shard port უნდა იყოს 1-დან 65535-მდე.');
  }
  if (!Number.isInteger(input.maxPlayers) || input.maxPlayers < 1 || input.maxPlayers > 250) {
    fail(400, 'INVALID_SHARD_CAPACITY', 'Shard capacity უნდა იყოს 1-დან 250-მდე.');
  }
  const protocolVersion = input.protocolVersion ?? 'ridge-0.6';
  if (typeof protocolVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(protocolVersion)) {
    fail(400, 'INVALID_PROTOCOL_VERSION', 'Protocol version არასწორია.');
  }
  return { serverId, region, host: host.toLowerCase(), port: input.port, maxPlayers: input.maxPlayers, protocolVersion };
}

function validateHeartbeat(input = {}, maxPlayers) {
  const currentPlayers = input.currentPlayers;
  const status = input.status ?? 'ready';
  if (!Number.isInteger(currentPlayers) || currentPlayers < 0 || currentPlayers > maxPlayers) {
    fail(400, 'INVALID_SHARD_PLAYER_COUNT', 'მოთამაშეების რაოდენობა shard-ის დასაშვებ ტევადობას უნდა შეესაბამებოდეს.');
  }
  if (!SERVER_STATUSES.has(status)) {
    fail(400, 'INVALID_SHARD_STATUS', 'Shard status უნდა იყოს ready, draining ან offline.');
  }
  return { currentPlayers: status === 'offline' ? 0 : currentPlayers, status };
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function serverIsLive(server, now, heartbeatTtlMs) {
  const lastHeartbeat = timestamp(server?.lastHeartbeatAt ?? server?.last_heartbeat_at);
  return Boolean(server) &&
    (server.status === 'ready' || server.status === 'draining') &&
    lastHeartbeat > 0 &&
    lastHeartbeat <= now + 5_000 &&
    now - lastHeartbeat <= heartbeatTtlMs;
}

function publicServer(server) {
  return {
    serverId: server.serverId ?? server.server_id,
    region: server.region,
    host: server.host,
    port: Number(server.port),
    protocolVersion: server.protocolVersion ?? server.protocol_version,
    maxPlayers: Number(server.maxPlayers ?? server.max_players),
    currentPlayers: Number(server.currentPlayers ?? server.current_players),
    status: server.status,
  };
}

function publicAllocation(session, server, reused = false) {
  const lease = session.leaseExpiresAt ?? session.lease_expires_at ?? null;
  return {
    sessionId: session.sessionId ?? session.session_id,
    playerId: session.playerId ?? session.player_id,
    server: publicServer(server),
    status: session.status,
    leaseExpiresAt: lease ? new Date(timestamp(lease)).toISOString() : null,
    reused,
  };
}

function createMemoryRegistry({ clock, leaseMs, heartbeatTtlMs, joinTicketMs, serverCredentialMs }) {
  const servers = new Map();
  const sessions = new Map();
  const serverCredentials = new Map();
  const serverCredentialEvents = [];
  let nextCredentialAuditSequence = 1;

  function findServer(serverId) {
    const server = servers.get(serverId);
    if (!server) fail(404, 'SHARD_NOT_FOUND', 'მითითებული shard ვერ მოიძებნა.');
    return server;
  }

  function allocatedReservations(serverId, now) {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.serverId === serverId && session.status === 'allocated' &&
          session.leaseExpiresAt > now) count += 1;
    }
    return count;
  }

  function connectedReservations(serverId) {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.serverId === serverId && session.status === 'connected') count += 1;
    }
    return count;
  }

  function expireSession(session) {
    session.status = 'expired';
    session.updatedAt = clock();
    session.leaseExpiresAt = null;
    session.joinTicketHash = null;
    session.joinTicketExpiresAt = null;
    session.joinAttemptId = null;
  }

  function serializeSession(session) {
    return {
      sessionId: session.sessionId,
      playerId: session.playerId,
      serverId: session.serverId,
      status: session.status,
      leaseExpiresAt: session.leaseExpiresAt ? new Date(session.leaseExpiresAt).toISOString() : null,
    };
  }

  return Object.freeze({
    storageMode: 'memory-ephemeral',

    async issueServerCredential({ serverId }) {
      validIdentifier(serverId, 'server_id');
      const token = randomBytes(32).toString('base64url');
      const credentialId = randomUUID();
      const now = clock();
      const expiresAt = now + serverCredentialMs;
      const previous = serverCredentials.get(serverId);
      const isActivePrevious = Boolean(previous && !previous.revokedAt && previous.expiresAt > now);
      serverCredentials.set(serverId, {
        credentialId,
        tokenHash: hashServerCredential(token),
        expiresAt,
        revokedAt: null,
      });
      serverCredentialEvents.unshift({
        auditSequence: nextCredentialAuditSequence++,
        eventId: randomUUID(),
        serverId,
        credentialId,
        previousCredentialId: isActivePrevious ? previous.credentialId : null,
        action: isActivePrevious ? 'rotated' : 'issued',
        occurredAt: new Date(now).toISOString(),
      });
      return { serverId, credentialId, token, expiresAt: new Date(expiresAt).toISOString() };
    },

    async authenticateServerCredential({ serverId, token }) {
      validIdentifier(serverId, 'server_id');
      const tokenHash = hashServerCredential(token);
      if (!tokenHash) return false;
      const credential = serverCredentials.get(serverId);
      return Boolean(credential && !credential.revokedAt &&
        credential.expiresAt > clock() && secureHashEquals(tokenHash, credential.tokenHash));
    },

    async revokeServerCredential({ serverId }) {
      validIdentifier(serverId, 'server_id');
      const credential = serverCredentials.get(serverId);
      if (!credential || credential.revokedAt) return { revoked: false };
      const now = clock();
      credential.revokedAt = now;
      serverCredentialEvents.unshift({
        auditSequence: nextCredentialAuditSequence++,
        eventId: randomUUID(),
        serverId,
        credentialId: credential.credentialId,
        previousCredentialId: null,
        action: 'revoked',
        occurredAt: new Date(now).toISOString(),
      });
      return { revoked: true, credentialId: credential.credentialId };
    },

    async listServerCredentialEvents({ serverId, limit = 50 } = {}) {
      validIdentifier(serverId, 'server_id');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        fail(400, 'INVALID_CREDENTIAL_AUDIT_LIMIT', 'Audit limit უნდა იყოს 1-დან 100-მდე.');
      }
      return serverCredentialEvents
        .filter((event) => event.serverId === serverId)
        .slice(0, limit)
        .map((event) => ({
          eventId: event.eventId,
          serverId: event.serverId,
          credentialId: event.credentialId,
          previousCredentialId: event.previousCredentialId,
          action: event.action,
          occurredAt: event.occurredAt,
        }));
    },



    async registerServer(input) {
      const registration = validateRegistration(input);
      const now = clock();
      const existing = servers.get(registration.serverId);
      const activeConnected = connectedReservations(registration.serverId);
      const activeAllocated = allocatedReservations(registration.serverId, now);
      if (existing && activeConnected + activeAllocated > 0) {
        fail(409, 'SHARD_INSTANCE_ID_IN_USE', 'აქტიური სესიების მქონე shard instance ID ხელახლა არ გამოიყენება.');
      }
      const server = {
        ...registration,
        currentPlayers: existing?.currentPlayers ?? 0,
        status: 'ready',
        lastHeartbeatAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      servers.set(server.serverId, server);
      return { ...publicServer(server), lastHeartbeatAt: new Date(now).toISOString() };
    },

    async heartbeatServer(serverId, input) {
      validIdentifier(serverId, 'server_id');
      const server = findServer(serverId);
      const heartbeat = validateHeartbeat(input, server.maxPlayers);
      server.currentPlayers = heartbeat.currentPlayers;
      server.status = heartbeat.status;
      server.lastHeartbeatAt = clock();
      server.updatedAt = server.lastHeartbeatAt;
      if (server.status === 'offline') {
        for (const session of sessions.values()) {
          if (session.serverId === serverId && ACTIVE_SESSION_STATUSES.has(session.status)) expireSession(session);
        }
      }
      return { ...publicServer(server), lastHeartbeatAt: new Date(server.lastHeartbeatAt).toISOString() };
    },

    async allocatePlayer(playerId, region) {
      validIdentifier(playerId, 'player_id');
      const selectedRegion = validIdentifier(region, 'region', 64).toLowerCase();
      const now = clock();
      const existing = sessions.get(playerId);
      if (existing && ACTIVE_SESSION_STATUSES.has(existing.status)) {
        const existingServer = servers.get(existing.serverId);
        const leaseValid = existing.status === 'connected' ||
          (existing.leaseExpiresAt !== null && existing.leaseExpiresAt > now);
        if (leaseValid && serverIsLive(existingServer, now, heartbeatTtlMs)) {
          if (existingServer.region !== selectedRegion) {
            fail(409, 'SESSION_REGION_TRANSFER_REQUIRED', 'აქტიური სესიის სხვა რეგიონში გადატანა ცალკე transfer პროცესს მოითხოვს.');
          }
          return publicAllocation(existing, existingServer, true);
        }
        expireSession(existing);
      }

      const candidates = [];
      for (const server of servers.values()) {
        if (server.region !== selectedRegion || server.status !== 'ready' ||
            !serverIsLive(server, now, heartbeatTtlMs)) continue;
        const connected = Math.max(server.currentPlayers, connectedReservations(server.serverId));
        const reserved = allocatedReservations(server.serverId, now);
        const effectivePlayers = connected + reserved;
        if (effectivePlayers >= server.maxPlayers) continue;
        candidates.push({ server, effectivePlayers, utilization: effectivePlayers / server.maxPlayers });
      }
      candidates.sort((a, b) =>
        a.utilization - b.utilization ||
        a.effectivePlayers - b.effectivePlayers ||
        a.server.serverId.localeCompare(b.server.serverId));
      const selected = candidates[0];
      if (!selected) fail(503, 'NO_AVAILABLE_SHARD', 'ამ რეგიონში თავისუფალი და ჯანმრთელი shard არ არის.');

      const session = {
        sessionId: randomUUID(),
        playerId,
        serverId: selected.server.serverId,
        status: 'allocated',
        leaseExpiresAt: now + leaseMs,
        createdAt: now,
        updatedAt: now,
        connectedAt: null,
        joinTicketHash: null,
        joinTicketExpiresAt: null,
        joinAttemptId: null,
      };
      sessions.set(playerId, session);
      return publicAllocation(session, selected.server, false);
    },

    async issueJoinTicket({ playerId, sessionId, serverId }) {
      validIdentifier(playerId, 'player_id');
      validIdentifier(serverId, 'server_id');
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        fail(400, 'INVALID_SESSION_ID', 'Session ID არასწორია.');
      }
      const session = sessions.get(playerId);
      const now = clock();
      if (!session || session.sessionId !== sessionId || session.serverId !== serverId ||
          session.status !== 'allocated') {
        fail(409, 'SESSION_NOT_ALLOCATED', 'Join ticket გაიცემა მხოლოდ აქტიურ allocation-ზე.');
      }
      if (!session.leaseExpiresAt || session.leaseExpiresAt <= now) {
        expireSession(session);
        fail(409, 'SESSION_LEASE_EXPIRED', 'Session lease ვადაგასულია.');
      }
      const server = findServer(serverId);
      if (!serverIsLive(server, now, heartbeatTtlMs)) {
        fail(409, 'SHARD_NOT_LIVE', 'Shard heartbeat მოძველებულია ან სერვერი მზად არ არის.');
      }
      if (session.joinTicketHash && session.joinTicketExpiresAt !== null &&
          session.joinTicketExpiresAt > now) {
        fail(409, 'SESSION_JOIN_TICKET_ALREADY_ISSUED', 'ამ allocation-ს მოქმედი join ticket უკვე აქვს; მისი ჩანაცვლება დაუშვებელია.');
      }
      const ticket = randomBytes(32).toString('base64url');
      const claimAttemptId = randomUUID();
      const expiresAt = Math.min(session.leaseExpiresAt, now + joinTicketMs);
      session.joinTicketHash = hashJoinTicket(ticket);
      session.joinTicketExpiresAt = expiresAt;
      session.joinAttemptId = claimAttemptId;
      session.updatedAt = now;
      return {
        ticket,
        claimAttemptId,
        expiresAt: new Date(expiresAt).toISOString(),
        sessionId,
        playerId,
        server: publicServer(server),
      };
    },

    async claimJoinTicket({ serverId, ticket, claimAttemptId }) {
      validIdentifier(serverId, 'server_id');
      const ticketHash = hashJoinTicket(ticket);
      const attemptId = validateClaimAttemptId(claimAttemptId);
      const now = clock();
      const session = [...sessions.values()].find(
        (item) => item.serverId === serverId && item.joinTicketHash === ticketHash,
      );
      if (!session) fail(403, 'JOIN_TICKET_INVALID', 'Join ticket არასწორია, უკვე გამოყენებულია ან ვადაგასულია.');
      const server = findServer(serverId);
      if (!serverIsLive(server, now, heartbeatTtlMs)) {
        fail(409, 'SHARD_NOT_LIVE', 'Shard heartbeat მოძველებულია ან სერვერი მზად არ არის.');
      }
      if (session.status === 'connected') {
        if (session.joinAttemptId === attemptId) {
          return {
            playerId: session.playerId,
            sessionId: session.sessionId,
            serverId,
            status: 'connected',
            connected: true,
            replayed: true,
          };
        }
        fail(409, 'JOIN_TICKET_ALREADY_USED', 'Join ticket უკვე გამოყენებულია სხვა კავშირისთვის.');
      }
      if (session.status !== 'allocated') {
        fail(403, 'JOIN_TICKET_INVALID', 'Join ticket აქტიურ allocation-ს აღარ ეკუთვნის.');
      }
      if (session.joinAttemptId !== attemptId) {
        fail(409, 'JOIN_TICKET_CLAIM_ATTEMPT_MISMATCH', 'Join ticket-ის claim attempt ID არ ემთხვევა.');
      }
      if (!session.joinTicketExpiresAt || session.joinTicketExpiresAt <= now ||
          !session.leaseExpiresAt || session.leaseExpiresAt <= now) {
        expireSession(session);
        fail(409, 'JOIN_TICKET_EXPIRED', 'Join ticket ან session lease ვადაგასულია.');
      }
      session.status = 'connected';
      session.leaseExpiresAt = null;
      session.connectedAt = now;
      session.joinAttemptId = attemptId;
      session.updatedAt = now;
      return {
        playerId: session.playerId,
        sessionId: session.sessionId,
        serverId,
        status: 'connected',
        connected: true,
        replayed: false,
      };
    },

    async releaseSession({ playerId, sessionId, serverId }) {
      validIdentifier(playerId, 'player_id');
      validIdentifier(serverId, 'server_id');
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        fail(400, 'INVALID_SESSION_ID', 'Session ID არასწორია.');
      }
      const session = sessions.get(playerId);
      if (!session || session.sessionId !== sessionId || session.serverId !== serverId) {
        return { released: false, replayed: false };
      }
      if (session.status === 'released' || session.status === 'expired') {
        return { released: true, replayed: true };
      }
      session.status = 'released';
      session.leaseExpiresAt = null;
      session.joinTicketHash = null;
      session.joinTicketExpiresAt = null;
      session.joinAttemptId = null;
      session.updatedAt = clock();
      return { released: true, replayed: false };
    },

    async listServers(region) {
      const selectedRegion = region ? String(region).toLowerCase() : null;
      const now = clock();
      return [...servers.values()]
        .filter((server) => !selectedRegion || server.region === selectedRegion)
        .map((server) => ({
          ...publicServer(server),
          reservedPlayers: allocatedReservations(server.serverId, now),
          connectedSessions: connectedReservations(server.serverId),
          heartbeatFresh: serverIsLive(server, now, heartbeatTtlMs),
          lastHeartbeatAt: new Date(server.lastHeartbeatAt).toISOString(),
        }));
    },

    async healthCheck() { return true; },
  });
}

async function inTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

function fromServerRow(row) {
  return {
    serverId: row.server_id,
    region: row.region,
    host: row.host,
    port: Number(row.port),
    protocolVersion: row.protocol_version,
    maxPlayers: Number(row.max_players),
    currentPlayers: Number(row.current_players),
    status: row.status,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

function fromSessionRow(row) {
  return {
    sessionId: row.session_id,
    playerId: row.player_id,
    serverId: row.server_id,
    status: row.status,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function createPostgresRegistry({ pool, clock, leaseMs, heartbeatTtlMs, joinTicketMs, serverCredentialMs }) {
  async function requireServer(client, serverId, lock = false) {
    const sql = 'SELECT server_id, region, host, port, protocol_version, max_players, ' +
      'current_players, status, last_heartbeat_at FROM ridge.dedicated_servers ' +
      'WHERE server_id = $1' + (lock ? ' FOR UPDATE' : '');
    const result = await client.query(sql, [serverId]);
    if (!result.rows[0]) fail(404, 'SHARD_NOT_FOUND', 'მითითებული shard ვერ მოიძებნა.');
    return fromServerRow(result.rows[0]);
  }

  function ensureServerLive(server) {
    if (!serverIsLive(server, clock(), heartbeatTtlMs)) {
      fail(409, 'SHARD_NOT_LIVE', 'Shard heartbeat მოძველებულია ან სერვერი მზად არ არის.');
    }
  }

  return Object.freeze({
    storageMode: 'postgresql',

    async issueServerCredential({ serverId }) {
      validIdentifier(serverId, 'server_id');
      const token = randomBytes(32).toString('base64url');
      const tokenHash = hashServerCredential(token);
      const credentialId = randomUUID();
      return inTransaction(pool, async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          ['ridge-server-credential:' + serverId],
        );
        const previousResult = await client.query(
          'SELECT credential_id, revoked_at, (expires_at > clock_timestamp()) AS is_active ' +
          'FROM ridge.dedicated_server_credentials WHERE server_id = $1 FOR UPDATE',
          [serverId],
        );
        const previous = previousResult.rows[0] ?? null;
        const isActivePrevious = Boolean(previous && !previous.revoked_at && previous.is_active);
        const action = isActivePrevious ? 'rotated' : 'issued';
        const previousCredentialId = isActivePrevious ? previous.credential_id : null;
        const result = await client.query(
          'INSERT INTO ridge.dedicated_server_credentials ' +
          '(server_id, credential_id, token_hash, expires_at, revoked_at, created_at, updated_at) ' +
          "VALUES ($1, $2, $3, clock_timestamp() + ($4::bigint * interval '1 millisecond'), NULL, clock_timestamp(), clock_timestamp()) " +
          'ON CONFLICT (server_id) DO UPDATE SET credential_id = EXCLUDED.credential_id, ' +
          'token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, revoked_at = NULL, updated_at = clock_timestamp() ' +
          'RETURNING credential_id, expires_at',
          [serverId, credentialId, tokenHash, serverCredentialMs],
        );
        await client.query(
          'INSERT INTO ridge.dedicated_server_credential_events ' +
          '(server_id, credential_id, previous_credential_id, action) VALUES ($1, $2, $3, $4)',
          [serverId, result.rows[0].credential_id, previousCredentialId, action],
        );
        return {
          serverId,
          credentialId: result.rows[0].credential_id,
          token,
          expiresAt: new Date(result.rows[0].expires_at).toISOString(),
        };
      });
    },

    async authenticateServerCredential({ serverId, token }) {
      validIdentifier(serverId, 'server_id');
      const tokenHash = hashServerCredential(token);
      if (!tokenHash) return false;
      const result = await pool.query(
        'SELECT token_hash FROM ridge.dedicated_server_credentials ' +
        'WHERE server_id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()',
        [serverId],
      );
      return Boolean(result.rows[0] && secureHashEquals(tokenHash, result.rows[0].token_hash));
    },

    async revokeServerCredential({ serverId }) {
      validIdentifier(serverId, 'server_id');
      return inTransaction(pool, async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          ['ridge-server-credential:' + serverId],
        );
        const result = await client.query(
          'UPDATE ridge.dedicated_server_credentials SET revoked_at = clock_timestamp(), updated_at = clock_timestamp() ' +
          'WHERE server_id = $1 AND revoked_at IS NULL RETURNING credential_id',
          [serverId],
        );
        if (!result.rows[0]) return { revoked: false };
        await client.query(
          'INSERT INTO ridge.dedicated_server_credential_events ' +
          '(server_id, credential_id, previous_credential_id, action) VALUES ($1, $2, NULL, $3)',
          [serverId, result.rows[0].credential_id, 'revoked'],
        );
        return { revoked: true, credentialId: result.rows[0].credential_id };
      });
    },

    async listServerCredentialEvents({ serverId, limit = 50 } = {}) {
      validIdentifier(serverId, 'server_id');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        fail(400, 'INVALID_CREDENTIAL_AUDIT_LIMIT', 'Audit limit უნდა იყოს 1-დან 100-მდე.');
      }
      const result = await pool.query(
        'SELECT event_id, server_id, credential_id, previous_credential_id, action, occurred_at ' +
        'FROM ridge.dedicated_server_credential_events WHERE server_id = $1 ' +
        'ORDER BY audit_sequence DESC LIMIT $2',
        [serverId, limit],
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        serverId: row.server_id,
        credentialId: row.credential_id,
        previousCredentialId: row.previous_credential_id,
        action: row.action,
        occurredAt: new Date(row.occurred_at).toISOString(),
      }));
    },



    async registerServer(input) {
      const r = validateRegistration(input);
      const sql = 'INSERT INTO ridge.dedicated_servers ' +
        '(server_id, region, host, port, max_players, protocol_version, current_players, status, last_heartbeat_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, 0, 'ready', clock_timestamp()) " +
        'ON CONFLICT (server_id) DO UPDATE SET region = EXCLUDED.region, host = EXCLUDED.host, ' +
        'port = EXCLUDED.port, max_players = EXCLUDED.max_players, protocol_version = EXCLUDED.protocol_version, ' +
        "current_players = 0, status = 'ready', last_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() " +
        'WHERE (SELECT count(*) FROM ridge.player_sessions WHERE server_id = EXCLUDED.server_id ' +
        "AND status IN ('allocated', 'connected')) = 0 " +
        'RETURNING server_id, region, host, port, protocol_version, max_players, current_players, status, last_heartbeat_at';
      const result = await pool.query(sql, [r.serverId, r.region, r.host, r.port, r.maxPlayers, r.protocolVersion]);
      if (!result.rows[0]) fail(409, 'SHARD_INSTANCE_ID_IN_USE', 'აქტიური სესიების მქონე shard instance ID ხელახლა არ გამოიყენება.');
      const row = result.rows[0];
      return { ...publicServer(fromServerRow(row)), lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString() };
    },

    async heartbeatServer(serverId, input) {
      validIdentifier(serverId, 'server_id');
      const server = await requireServer(pool, serverId);
      const h = validateHeartbeat(input, server.maxPlayers);
      return inTransaction(pool, async (client) => {
        const result = await client.query(
          'UPDATE ridge.dedicated_servers SET current_players = $2, status = $3, ' +
          'last_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() WHERE server_id = $1 ' +
          'RETURNING server_id, region, host, port, protocol_version, max_players, current_players, status, last_heartbeat_at',
          [serverId, h.currentPlayers, h.status],
        );
        if (!result.rows[0]) fail(404, 'SHARD_NOT_FOUND', 'მითითებული shard ვერ მოიძებნა.');
        if (h.status === 'offline') {
          await client.query(
            "UPDATE ridge.player_sessions SET status = 'expired', lease_expires_at = NULL, join_ticket_hash = NULL, " +
            "join_ticket_expires_at = NULL, join_attempt_id = NULL, updated_at = clock_timestamp() " +
            "WHERE server_id = $1 AND status IN ('allocated', 'connected')",
            [serverId],
          );
        }
        const row = result.rows[0];
        return { ...publicServer(fromServerRow(row)), lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString() };
      });
    },

    async allocatePlayer(playerId, region) {
      validIdentifier(playerId, 'player_id');
      const selectedRegion = validIdentifier(region, 'region', 64).toLowerCase();
      return inTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['ridge-session:' + playerId]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['ridge-region:' + selectedRegion]);

        const existingSql = 'SELECT ps.session_id, ps.player_id, ps.server_id, ps.status, ps.lease_expires_at, ' +
          'ds.region, ds.host, ds.port, ds.protocol_version, ds.max_players, ds.current_players, ' +
          'ds.status AS server_status, ds.last_heartbeat_at FROM ridge.player_sessions ps ' +
          'JOIN ridge.dedicated_servers ds ON ds.server_id = ps.server_id ' +
          "WHERE ps.player_id = $1 AND ps.status IN ('allocated', 'connected') FOR UPDATE OF ps";
        const existingResult = await client.query(existingSql, [playerId]);
        if (existingResult.rows[0]) {
          const row = existingResult.rows[0];
          const leaseValid = row.status === 'connected' ||
            (row.lease_expires_at && new Date(row.lease_expires_at).getTime() > clock());
          const oldServer = { status: row.server_status, lastHeartbeatAt: row.last_heartbeat_at };
          if (leaseValid && serverIsLive(oldServer, clock(), heartbeatTtlMs)) {
            if (row.region !== selectedRegion) {
              fail(409, 'SESSION_REGION_TRANSFER_REQUIRED', 'აქტიური სესიის სხვა რეგიონში გადატანა ცალკე transfer პროცესს მოითხოვს.');
            }
            const existingSession = fromSessionRow(row);
            const existingServer = {
              serverId: row.server_id, region: row.region, host: row.host, port: row.port,
              protocolVersion: row.protocol_version, maxPlayers: row.max_players,
              currentPlayers: row.current_players, status: row.server_status,
            };
            return publicAllocation(existingSession, existingServer, true);
          }
          await client.query(
            "UPDATE ridge.player_sessions SET status = 'expired', lease_expires_at = NULL, join_ticket_hash = NULL, " +
            "join_ticket_expires_at = NULL, join_attempt_id = NULL, updated_at = clock_timestamp() " +
            'WHERE session_id = $1',
            [row.session_id],
          );
        }

        const candidateSql = 'SELECT ds.server_id, ds.region, ds.host, ds.port, ds.protocol_version, ' +
          'ds.max_players, ds.current_players, ds.status, ds.last_heartbeat_at, ' +
          'COALESCE(counts.connected_count, 0)::int AS connected_count, ' +
          'COALESCE(counts.reserved_count, 0)::int AS reserved_count ' +
          'FROM ridge.dedicated_servers ds LEFT JOIN LATERAL (' +
          "SELECT count(*) FILTER (WHERE status = 'connected')::int AS connected_count, " +
          "count(*) FILTER (WHERE status = 'allocated' AND lease_expires_at > clock_timestamp())::int AS reserved_count " +
          'FROM ridge.player_sessions WHERE server_id = ds.server_id) counts ON TRUE ' +
          "WHERE ds.region = $1 AND ds.status = 'ready' " +
          'AND ds.last_heartbeat_at > clock_timestamp() - ($2::bigint * interval \'1 millisecond\') ' +
          'AND GREATEST(ds.current_players, COALESCE(counts.connected_count, 0)) + ' +
          'COALESCE(counts.reserved_count, 0) < ds.max_players ' +
          'ORDER BY (GREATEST(ds.current_players, COALESCE(counts.connected_count, 0)) + ' +
          'COALESCE(counts.reserved_count, 0))::numeric / ds.max_players, ds.server_id ' +
          'LIMIT 1 FOR UPDATE OF ds';
        const candidateResult = await client.query(candidateSql, [selectedRegion, heartbeatTtlMs]);
        if (!candidateResult.rows[0]) fail(503, 'NO_AVAILABLE_SHARD', 'ამ რეგიონში თავისუფალი და ჯანმრთელი shard არ არის.');

        const candidate = fromServerRow(candidateResult.rows[0]);
        const created = await client.query(
          "INSERT INTO ridge.player_sessions (player_id, server_id, status, lease_expires_at) " +
          "VALUES ($1, $2, 'allocated', clock_timestamp() + ($3::bigint * interval '1 millisecond')) " +
          'RETURNING session_id, player_id, server_id, status, lease_expires_at',
          [playerId, candidate.serverId, leaseMs],
        );
        return publicAllocation(fromSessionRow(created.rows[0]), candidate, false);
      });
    },

    async issueJoinTicket({ playerId, sessionId, serverId }) {
      validIdentifier(playerId, 'player_id');
      validIdentifier(serverId, 'server_id');
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        fail(400, 'INVALID_SESSION_ID', 'Session ID არასწორია.');
      }
      const ticket = randomBytes(32).toString('base64url');
      const claimAttemptId = randomUUID();
      const ticketHash = hashJoinTicket(ticket);
      return inTransaction(pool, async (client) => {
        const selected = await client.query(
          'SELECT ps.session_id, ps.player_id, ps.server_id, ps.status, ps.lease_expires_at, ' +
          'ps.join_ticket_hash, ps.join_ticket_expires_at, ' +
          'ds.region, ds.host, ds.port, ds.protocol_version, ds.max_players, ds.current_players, ' +
          'ds.status AS server_status, ds.last_heartbeat_at ' +
          'FROM ridge.player_sessions ps JOIN ridge.dedicated_servers ds ON ds.server_id = ps.server_id ' +
          'WHERE ps.session_id = $1 AND ps.player_id = $2 AND ps.server_id = $3 FOR UPDATE OF ps',
          [sessionId, playerId, serverId],
        );
        const row = selected.rows[0];
        if (!row || row.status !== 'allocated') {
          fail(409, 'SESSION_NOT_ALLOCATED', 'Join ticket გაიცემა მხოლოდ აქტიურ allocation-ზე.');
        }
        if (!row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= clock()) {
          fail(409, 'SESSION_LEASE_EXPIRED', 'Session lease ვადაგასულია.');
        }
        if (row.join_ticket_hash && row.join_ticket_expires_at &&
            new Date(row.join_ticket_expires_at).getTime() > clock()) {
          fail(409, 'SESSION_JOIN_TICKET_ALREADY_ISSUED', 'ამ allocation-ს მოქმედი join ticket უკვე აქვს; მისი ჩანაცვლება დაუშვებელია.');
        }
        ensureServerLive({ status: row.server_status, lastHeartbeatAt: row.last_heartbeat_at });
        const updated = await client.query(
          'UPDATE ridge.player_sessions SET join_ticket_hash = $2, ' +
          "join_ticket_expires_at = LEAST(lease_expires_at, clock_timestamp() + ($3::bigint * interval '1 millisecond')), " +
          'join_attempt_id = $4, updated_at = clock_timestamp() WHERE session_id = $1 ' +
          'RETURNING join_ticket_expires_at',
          [sessionId, ticketHash, joinTicketMs, claimAttemptId],
        );
        if (!updated.rows[0]) fail(404, 'SESSION_NOT_FOUND', 'მოთამაშის სესია ვერ მოიძებნა.');
        return {
          ticket,
          claimAttemptId,
          expiresAt: new Date(updated.rows[0].join_ticket_expires_at).toISOString(),
          sessionId: row.session_id,
          playerId: row.player_id,
          server: publicServer({
            serverId: row.server_id, region: row.region, host: row.host, port: row.port,
            protocolVersion: row.protocol_version, maxPlayers: row.max_players,
            currentPlayers: row.current_players, status: row.server_status,
          }),
        };
      });
    },

    async claimJoinTicket({ serverId, ticket, claimAttemptId }) {
      validIdentifier(serverId, 'server_id');
      const ticketHash = hashJoinTicket(ticket);
      const attemptId = validateClaimAttemptId(claimAttemptId);
      return inTransaction(pool, async (client) => {
        const result = await client.query(
          'SELECT ps.session_id, ps.player_id, ps.server_id, ps.status, ps.lease_expires_at, ' +
          'ps.join_ticket_expires_at, ps.join_attempt_id, ds.status AS server_status, ds.last_heartbeat_at ' +
          'FROM ridge.player_sessions ps JOIN ridge.dedicated_servers ds ON ds.server_id = ps.server_id ' +
          'WHERE ps.server_id = $1 AND ps.join_ticket_hash = $2 FOR UPDATE OF ps',
          [serverId, ticketHash],
        );
        const row = result.rows[0];
        if (!row) fail(403, 'JOIN_TICKET_INVALID', 'Join ticket არასწორია, უკვე გამოყენებულია ან ვადაგასულია.');
        ensureServerLive({ status: row.server_status, lastHeartbeatAt: row.last_heartbeat_at });
        if (row.status === 'connected') {
          if (row.join_attempt_id === attemptId) {
            return {
              playerId: row.player_id,
              sessionId: row.session_id,
              serverId,
              status: 'connected',
              connected: true,
              replayed: true,
            };
          }
          fail(409, 'JOIN_TICKET_ALREADY_USED', 'Join ticket უკვე გამოყენებულია სხვა კავშირისთვის.');
        }
        if (row.status !== 'allocated') {
          fail(403, 'JOIN_TICKET_INVALID', 'Join ticket აქტიურ allocation-ს აღარ ეკუთვნის.');
        }
        if (row.join_attempt_id !== attemptId) {
          fail(409, 'JOIN_TICKET_CLAIM_ATTEMPT_MISMATCH', 'Join ticket-ის claim attempt ID არ ემთხვევა.');
        }
        const now = clock();
        if (!row.join_ticket_expires_at || new Date(row.join_ticket_expires_at).getTime() <= now ||
            !row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= now) {
          fail(409, 'JOIN_TICKET_EXPIRED', 'Join ticket ან session lease ვადაგასულია.');
        }
        const updated = await client.query(
          "UPDATE ridge.player_sessions SET status = 'connected', lease_expires_at = NULL, " +
          'connected_at = clock_timestamp(), join_attempt_id = $2, updated_at = clock_timestamp() ' +
          'WHERE session_id = $1 RETURNING session_id, player_id, server_id',
          [row.session_id, attemptId],
        );
        return {
          playerId: updated.rows[0].player_id,
          sessionId: updated.rows[0].session_id,
          serverId: updated.rows[0].server_id,
          status: 'connected',
          connected: true,
          replayed: false,
        };
      });
    },

    async releaseSession({ playerId, sessionId, serverId }) {
      validIdentifier(playerId, 'player_id');
      validIdentifier(serverId, 'server_id');
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        fail(400, 'INVALID_SESSION_ID', 'Session ID არასწორია.');
      }
      const result = await pool.query(
        "UPDATE ridge.player_sessions SET status = 'released', lease_expires_at = NULL, join_ticket_hash = NULL, " +
        "join_ticket_expires_at = NULL, join_attempt_id = NULL, updated_at = clock_timestamp() " +
        "WHERE session_id = $1 AND player_id = $2 AND server_id = $3 AND status IN ('allocated', 'connected') RETURNING session_id",
        [sessionId, playerId, serverId],
      );
      if (result.rows[0]) return { released: true, replayed: false };
      const existing = await pool.query(
        'SELECT status FROM ridge.player_sessions WHERE session_id = $1 AND player_id = $2 AND server_id = $3',
        [sessionId, playerId, serverId],
      );
      if (existing.rows[0] && ['released', 'expired'].includes(existing.rows[0].status)) {
        return { released: true, replayed: true };
      }
      return { released: false, replayed: false };
    },

    async listServers(region) {
      const params = [];
      let where = '';
      if (region) {
        params.push(String(region).toLowerCase());
        where = 'WHERE ds.region = $1';
      }
      const sql = 'SELECT ds.server_id, ds.region, ds.host, ds.port, ds.protocol_version, ' +
        'ds.max_players, ds.current_players, ds.status, ds.last_heartbeat_at, ' +
        "(SELECT count(*)::int FROM ridge.player_sessions s WHERE s.server_id = ds.server_id " +
        "AND s.status = 'allocated' AND s.lease_expires_at > clock_timestamp()) AS reserved_players, " +
        "(SELECT count(*)::int FROM ridge.player_sessions s WHERE s.server_id = ds.server_id " +
        "AND s.status = 'connected') AS connected_sessions " +
        'FROM ridge.dedicated_servers ds ' + where + ' ORDER BY ds.region, ds.server_id';
      const result = await pool.query(sql, params);
      return result.rows.map((row) => ({
        ...publicServer(fromServerRow(row)),
        reservedPlayers: Number(row.reserved_players),
        connectedSessions: Number(row.connected_sessions),
        heartbeatFresh: serverIsLive({ status: row.status, lastHeartbeatAt: row.last_heartbeat_at }, clock(), heartbeatTtlMs),
        lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString(),
      }));
    },

    async healthCheck() {
      const result = await pool.query(
        "SELECT to_regclass('ridge.dedicated_servers') AS servers, " +
        "to_regclass('ridge.player_sessions') AS sessions, " +
        "to_regclass('ridge.dedicated_server_credentials') AS credentials, " +
        "to_regclass('ridge.dedicated_server_credential_events') AS credential_events",
      );
      return Boolean(
        result.rows[0]?.servers &&
        result.rows[0]?.sessions &&
        result.rows[0]?.credentials &&
        result.rows[0]?.credential_events
      );
    },
  });
}

export async function createSessionRegistry({
  pool = null,
  clock = () => Date.now(),
  leaseMs = DEFAULT_LEASE_MS,
  heartbeatTtlMs = DEFAULT_HEARTBEAT_TTL_MS,
  joinTicketMs = DEFAULT_JOIN_TICKET_MS,
  serverCredentialMs = DEFAULT_SERVER_CREDENTIAL_MS,
} = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) {
    throw new TypeError('leaseMs must be between 1000 and 300000.');
  }
  if (!Number.isSafeInteger(heartbeatTtlMs) || heartbeatTtlMs < 1000 || heartbeatTtlMs > 300_000) {
    throw new TypeError('heartbeatTtlMs must be between 1000 and 300000.');
  }
  if (!Number.isSafeInteger(joinTicketMs) || joinTicketMs < 1000 || joinTicketMs > 300_000) {
    throw new TypeError('joinTicketMs must be between 1000 and 300000.');
  }
  if (!Number.isSafeInteger(serverCredentialMs) || serverCredentialMs < 60_000 || serverCredentialMs > 365 * 24 * 60 * 60 * 1000) {
    throw new TypeError('serverCredentialMs must be between 60000 and 31536000000.');
  }
  if (!pool) return createMemoryRegistry({ clock, leaseMs, heartbeatTtlMs, joinTicketMs, serverCredentialMs });
  if (typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A configured node-postgres Pool is required.');
  }
  const schema = await pool.query(
    "SELECT to_regclass('ridge.dedicated_servers') AS servers, to_regclass('ridge.player_sessions') AS sessions, " +
    "EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'ridge' AND table_name = 'player_sessions' AND column_name = 'join_ticket_hash') " +
    "AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'ridge' AND table_name = 'player_sessions' AND column_name = 'join_ticket_expires_at') " +
    "AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'ridge' AND table_name = 'player_sessions' AND column_name = 'join_attempt_id') AS join_ticket_schema, " +
    "to_regclass('ridge.dedicated_server_credentials') AS server_credentials",
  );
  if (!schema.rows[0]?.servers || !schema.rows[0]?.sessions) {
    throw new Error('RIDGE session registry migration 004 is required before PostgreSQL startup.');
  }
  if (!schema.rows[0]?.join_ticket_schema) {
    throw new Error('RIDGE join ticket migration 005 is required before PostgreSQL startup.');
  }
  if (!schema.rows[0]?.server_credentials) {
    throw new Error('RIDGE per-instance server credential migration 006 is required before PostgreSQL startup.');
  }
  return createPostgresRegistry({ pool, clock, leaseMs, heartbeatTtlMs, joinTicketMs, serverCredentialMs });
}
