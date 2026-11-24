import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

function decodeBase64UrlJson(segment, label) {
  if (typeof segment !== 'string' || !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length > 16_384) {
    throw new Error('OIDC token has an invalid ' + label + ' segment.');
  }
  try {
    const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new Error('OIDC token has an invalid ' + label + ' JSON payload.');
  }
}

function parseBearer(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function deriveCanonicalPlayerId(issuer, subject) {
  if (typeof issuer !== 'string' || !issuer.trim() ||
      typeof subject !== 'string' || !subject.trim() || subject.length > 255) {
    throw new TypeError('A verified OIDC issuer and subject are required.');
  }
  const digest = createHash('sha256')
    .update(issuer, 'utf8')
    .update('\0', 'utf8')
    .update(subject, 'utf8')
    .digest('hex');
  return 'oidc_' + digest;
}

export function createOidcVerifier({
  issuer,
  audience,
  jwksUrl,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  allowHttpForDevelopment = false,
  cacheMs = 300_000,
  timeoutMs = 5_000,
} = {}) {
  if (typeof issuer !== 'string' || !issuer.startsWith('https://')) {
    throw new TypeError('RIDGE_OIDC_ISSUER must be an HTTPS issuer URL.');
  }
  if (typeof audience !== 'string' || !audience.trim()) {
    throw new TypeError('RIDGE_OIDC_AUDIENCE is required.');
  }
  let parsedJwksUrl;
  try {
    parsedJwksUrl = new URL(jwksUrl);
  } catch {
    throw new TypeError('RIDGE_OIDC_JWKS_URL must be a valid HTTPS URL.');
  }
  const localDevelopmentHost = ['127.0.0.1', 'localhost', '::1'].includes(parsedJwksUrl.hostname);
  if (parsedJwksUrl.protocol !== 'https:' &&
      !(allowHttpForDevelopment && parsedJwksUrl.protocol === 'http:' && localDevelopmentHost)) {
    throw new TypeError('RIDGE_OIDC_JWKS_URL must use HTTPS except for explicit loopback-only development tests.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isSafeInteger(cacheMs) || cacheMs < 1_000 || cacheMs > 3_600_000) {
    throw new TypeError('cacheMs must be between 1000 and 3600000.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) {
    throw new TypeError('timeoutMs must be between 500 and 30000.');
  }

  let cachedKeys = null;
  let cachedUntil = 0;
  let refreshPromise = null;

  async function loadJwks(force = false) {
    if (!force && cachedKeys && cachedUntil > clock()) return cachedKeys;
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      let response;
      try {
        response = await fetchImpl(parsedJwksUrl.toString(), {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        });
      } catch {
        const error = new Error('OIDC signing keys could not be downloaded.');
        error.code = 'OIDC_JWKS_UNAVAILABLE';
        throw error;
      }
      if (!response?.ok) {
        const error = new Error('OIDC signing keys endpoint returned an unsuccessful status.');
        error.code = 'OIDC_JWKS_UNAVAILABLE';
        throw error;
      }

      let text;
      try {
        text = await response.text();
      } catch {
        const error = new Error('OIDC signing keys response could not be read.');
        error.code = 'OIDC_JWKS_UNAVAILABLE';
        throw error;
      }
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 65_536) {
        const error = new Error('OIDC signing keys response is too large.');
        error.code = 'OIDC_JWKS_INVALID';
        throw error;
      }

      let document;
      try {
        document = JSON.parse(text);
      } catch {
        const error = new Error('OIDC signing keys response is not valid JSON.');
        error.code = 'OIDC_JWKS_INVALID';
        throw error;
      }
      if (!document || !Array.isArray(document.keys) || document.keys.length < 1 || document.keys.length > 32) {
        const error = new Error('OIDC signing keys response has an invalid keys collection.');
        error.code = 'OIDC_JWKS_INVALID';
        throw error;
      }

      const keys = document.keys.filter((key) =>
        key &&
        key.kty === 'RSA' &&
        typeof key.kid === 'string' &&
        key.kid.length > 0 &&
        key.kid.length <= 128 &&
        (!key.use || key.use === 'sig') &&
        (!key.alg || key.alg === 'RS256') &&
        typeof key.n === 'string' &&
        Buffer.from(key.n, 'base64url').length >= 256 &&
        key.e === 'AQAB'
      );
      if (keys.length === 0) throw new Error('OIDC signing keys response has no supported RS256 keys.');

      cachedKeys = keys;
      cachedUntil = clock() + cacheMs;
      return cachedKeys;
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  async function verifyToken(token) {
    if (typeof token !== 'string' || token.length > 16_384) {
      throw new Error('OIDC bearer token is missing or too large.');
    }
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('OIDC bearer token must be a compact signed JWT.');

    const header = decodeBase64UrlJson(parts[0], 'header');
    const claims = decodeBase64UrlJson(parts[1], 'claims');
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
      throw new Error('OIDC bearer token must use a configured RS256 signing key.');
    }
    if (header.crit !== undefined || header.jku !== undefined || header.x5u !== undefined || header.jwk !== undefined) {
      throw new Error('OIDC bearer token contains unsupported key or critical header parameters.');
    }

    let keys = await loadJwks();
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      keys = await loadJwks(true);
      jwk = keys.find((key) => key.kid === header.kid);
    }
    if (!jwk) throw new Error('OIDC token signing key ID is not present in the configured JWKS.');

    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      throw new Error('OIDC signing key is not a valid RSA public key.');
    }

    let signature;
    try {
      signature = Buffer.from(parts[2], 'base64url');
    } catch {
      throw new Error('OIDC token signature is malformed.');
    }
    const signingInput = Buffer.from(parts[0] + '.' + parts[1], 'utf8');
    if (!verifySignature('RSA-SHA256', signingInput, publicKey, signature)) {
      throw new Error('OIDC bearer token signature verification failed.');
    }

    const nowSeconds = Math.floor(clock() / 1000);
    if (claims.iss !== issuer) throw new Error('OIDC token issuer does not match the configured issuer.');
    const tokenAudiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!tokenAudiences.includes(audience)) throw new Error('OIDC token audience does not match this RIDGE gateway.');
    if (tokenAudiences.length > 1 && claims.azp !== audience) {
      throw new Error('OIDC token authorized party does not match this RIDGE gateway.');
    }
    if (!Number.isFinite(claims.exp) || nowSeconds >= claims.exp) {
      throw new Error('OIDC bearer token has expired or has no expiry.');
    }
    if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || nowSeconds + 5 < claims.nbf)) {
      throw new Error('OIDC bearer token is not active yet.');
    }
    if (!Number.isFinite(claims.iat) || claims.iat > nowSeconds + 60) {
      throw new Error('OIDC bearer token has an invalid issued-at time.');
    }
    if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 255) {
      throw new Error('OIDC bearer token has no valid subject.');
    }
    return Object.freeze({
      issuer: claims.iss,
      subject: claims.sub,
      audiences: tokenAudiences,
      expiresAt: claims.exp,
    });
  }

  return Object.freeze({
    verifyToken,
    async verifyAuthorizationHeader(header) {
      const token = parseBearer(header);
      if (!token) throw new Error('Authorization header must contain a Bearer token.');
      return verifyToken(token);
    },
  });
}
