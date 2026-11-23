import { randomUUID } from 'node:crypto';
import { RidgeError } from './game-service.mjs';

const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_HEARTBEAT_TTL_MS = 45_000;
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

function createMemoryRegistry({ clock, leaseMs, heartbeatTtlMs }) {
  const servers = new Map();
  const sessions = new Map();

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

    async registerServer(input) {
      const registration = validateRegistration(input);
      const now = clock();
      const existing = servers.get(registration.serverId);
      const activeConnected = connectedReservations(registration.serverId);
      const activeAllocated = allocatedReservations(registration.serverId, now);
      if (activeConnected + activeAllocated > registration.maxPlayers) {
        fail(409, 'SHARD_CAPACITY_BELOW_ACTIVE_SESSIONS', 'ახალი capacity აქტიურ სესიებზე ნაკლებია.');
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
      };
      sessions.set(playerId, session);
      return publicAllocation(session, selected.server, false);
    },

    async claimSession({ playerId, sessionId, serverId }) {
      validIdentifier(playerId, 'player_id');
      validIdentifier(serverId, 'server_id');
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        fail(400, 'INVALID_SESSION_ID', 'Session ID არასწორია.');
      }
      const session = sessions.get(playerId);
      if (!session || session.sessionId !== sessionId || session.serverId !== serverId ||
          !ACTIVE_SESSION_STATUSES.has(session.status)) {
        fail(404, 'SESSION_NOT_FOUND', 'აქტიური სესია ამ shard-ზე ვერ მოიძებნა.');
      }
      const server = findServer(serverId);
      if (!serverIsLive(server, clock(), heartbeatTtlMs)) {
        fail(409, 'SHARD_NOT_LIVE', 'Shard heartbeat მოძველებულია ან სერვერი მზად არ არის.');
      }
      if (session.status === 'connected') {
        return { ...serializeSession(session), connected: true, replayed: true };
      }
      if (!session.leaseExpiresAt || session.leaseExpiresAt <= clock()) {
        expireSession(session);
        fail(409, 'SESSION_LEASE_EXPIRED', 'Session lease ვადაგასულია.');
      }
      session.status = 'connected';
      session.leaseExpiresAt = null;
      session.connectedAt = clock();
      session.updatedAt = session.connectedAt;
      return { ...serializeSession(session), connected: true, replayed: false };
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

function createPostgresRegistry({ pool, clock, leaseMs, heartbeatTtlMs }) {
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

    async registerServer(input) {
      const r = validateRegistration(input);
      const sql = 'INSERT INTO ridge.dedicated_servers ' +
        '(server_id, region, host, port, max_players, protocol_version, current_players, status, last_heartbeat_at) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, 0, 'ready', clock_timestamp()) " +
        'ON CONFLICT (server_id) DO UPDATE SET region = EXCLUDED.region, host = EXCLUDED.host, ' +
        'port = EXCLUDED.port, max_players = EXCLUDED.max_players, protocol_version = EXCLUDED.protocol_version, ' +
        "current_players = 0, status = 'ready', last_heartbeat_at = clock_timestamp(), updated_at = clock_timestamp() " +
        'WHERE (SELECT count(*) FROM ridge.player_sessions WHERE server_id = EXCLUDED.server_id ' +
        "AND status IN ('allocated', 'connected')) <= EXCLUDED.max_players " +
        'RETURNING server_id, region, host, port, protocol_version, max_players, current_players, status, last_heartbeat_at';
      const result = await pool.query(sql, [r.serverId, r.region, r.host, r.port, r.maxPlayers, r.protocolVersion]);
      if (!result.rows[0]) fail(409, 'SHARD_CAPACITY_BELOW_ACTIVE_SESSIONS', 'ახალი capacity აქტიურ სესიებზე ნაკლებია.');
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
            "UPDATE ridge.player_sessions SET status = 'expired', lease_expires_at = NULL, updated_at = clock_timestamp() " +
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
            const existingSession = fromSessionRow(row);
            const existingServer = {
              serverId: row.server_id, region: row.region, host: row.host, port: row.port,
              protocolVersion: row.protocol_version, maxPlayers: row.max_players,
              currentPlayers: row.current_players, status: row.server_status,
            };
            return publicAllocation(existingSession, existingServer, true);
          }
          await client.query(
            "UPDATE ridge.player_sessions SET status = 'expired', lease_expires_at = NULL, updated_at = clock_timestamp() " +
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

    async claimSession({ playerId, sessionId, serverId }) {
      validIdentifier(playerId, 'player_id');
      validIdentifier(serverId, 'server_id');
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        fail(400, 'INVALID_SESSION_ID', 'Session ID არასწორია.');
      }
      return inTransaction(pool, async (client) => {
        const sql = 'SELECT ps.session_id, ps.player_id, ps.server_id, ps.status, ps.lease_expires_at, ' +
          'ds.status AS server_status, ds.last_heartbeat_at FROM ridge.player_sessions ps ' +
          'JOIN ridge.dedicated_servers ds ON ds.server_id = ps.server_id ' +
          "WHERE ps.session_id = $1 AND ps.player_id = $2 AND ps.server_id = $3 " +
          "AND ps.status IN ('allocated', 'connected') FOR UPDATE OF ps";
        const result = await client.query(sql, [sessionId, playerId, serverId]);
        const row = result.rows[0];
        if (!row) fail(404, 'SESSION_NOT_FOUND', 'აქტიური სესია ამ shard-ზე ვერ მოიძებნა.');
        ensureServerLive({ status: row.server_status, lastHeartbeatAt: row.last_heartbeat_at });
        if (row.status === 'connected') return { ...fromSessionRow(row), connected: true, replayed: true };
        if (!row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= clock()) {
          await client.query(
            "UPDATE ridge.player_sessions SET status = 'expired', lease_expires_at = NULL, updated_at = clock_timestamp() WHERE session_id = $1",
            [sessionId],
          );
          fail(409, 'SESSION_LEASE_EXPIRED', 'Session lease ვადაგასულია.');
        }
        const updated = await client.query(
          "UPDATE ridge.player_sessions SET status = 'connected', lease_expires_at = NULL, " +
          'connected_at = clock_timestamp(), updated_at = clock_timestamp() WHERE session_id = $1 ' +
          'RETURNING session_id, player_id, server_id, status, lease_expires_at',
          [sessionId],
        );
        return { ...fromSessionRow(updated.rows[0]), connected: true, replayed: false };
      });
    },

    async releaseSession({ playerId, sessionId, serverId }) {
      validIdentifier(playerId, 'player_id');
      validIdentifier(serverId, 'server_id');
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        fail(400, 'INVALID_SESSION_ID', 'Session ID არასწორია.');
      }
      const result = await pool.query(
        "UPDATE ridge.player_sessions SET status = 'released', lease_expires_at = NULL, updated_at = clock_timestamp() " +
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
        "SELECT to_regclass('ridge.dedicated_servers') AS servers, to_regclass('ridge.player_sessions') AS sessions",
      );
      return Boolean(result.rows[0]?.servers && result.rows[0]?.sessions);
    },
  });
}

export async function createSessionRegistry({
  pool = null,
  clock = () => Date.now(),
  leaseMs = DEFAULT_LEASE_MS,
  heartbeatTtlMs = DEFAULT_HEARTBEAT_TTL_MS,
} = {}) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000) {
    throw new TypeError('leaseMs must be between 1000 and 300000.');
  }
  if (!Number.isSafeInteger(heartbeatTtlMs) || heartbeatTtlMs < 1000 || heartbeatTtlMs > 300_000) {
    throw new TypeError('heartbeatTtlMs must be between 1000 and 300000.');
  }
  if (!pool) return createMemoryRegistry({ clock, leaseMs, heartbeatTtlMs });
  if (typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A configured node-postgres Pool is required.');
  }
  const schema = await pool.query(
    "SELECT to_regclass('ridge.dedicated_servers') AS servers, to_regclass('ridge.player_sessions') AS sessions",
  );
  if (!schema.rows[0]?.servers || !schema.rows[0]?.sessions) {
    throw new Error('RIDGE session registry migration 004 is required before PostgreSQL startup.');
  }
  return createPostgresRegistry({ pool, clock, leaseMs, heartbeatTtlMs });
}
