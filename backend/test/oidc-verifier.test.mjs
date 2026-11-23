import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createOidcVerifier, deriveCanonicalPlayerId } from '../src/oidc-verifier.mjs';

const ISSUER = 'https://identity.example.test/';
const AUDIENCE = 'ridge-game-api';
const JWKS_URL = 'https://identity.example.test/.well-known/jwks.json';
const NOW = 1_800_000_000_000;

function makeKey(kid = 'ridge-test-key-1') {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = pair.publicKey.export({ format: 'jwk' });
  return {
    kid,
    privateKey: pair.privateKey,
    jwk: { ...publicJwk, kid, use: 'sig', alg: 'RS256' },
  };
}

function makeToken(key, claims = {}, headerOverrides = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid: key.kid, ...headerOverrides };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'subject-123',
    iat: Math.floor(NOW / 1000) - 10,
    exp: Math.floor(NOW / 1000) + 300,
    ...claims,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const input = encodedHeader + '.' + encodedPayload;
  const signature = sign('RSA-SHA256', Buffer.from(input), key.privateKey).toString('base64url');
  return input + '.' + signature;
}

function fakeFetch(keys, counter = { count: 0 }) {
  return async (url, options) => {
    counter.count += 1;
    assert.equal(url, JWKS_URL);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return {
      ok: true,
      async text() { return JSON.stringify({ keys }); },
    };
  };
}

function makeVerifier(keys, options = {}) {
  return createOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: JWKS_URL,
    fetchImpl: fakeFetch(keys),
    clock: () => NOW,
    ...options,
  });
}

test('verifies RS256 OIDC token issuer, audience, expiry and canonical subject', async () => {
  const key = makeKey();
  const verifier = makeVerifier([key.jwk]);
  const token = makeToken(key, { email: 'private@example.test' });
  const result = await verifier.verifyToken(token);
  assert.equal(result.issuer, ISSUER);
  assert.equal(result.subject, 'subject-123');
  assert.deepEqual(result.audiences, [AUDIENCE]);
  assert.equal(result.expiresAt, Math.floor(NOW / 1000) + 300);
  assert.match(deriveCanonicalPlayerId(result.issuer, result.subject), /^oidc_[a-f0-9]{64}$/);
  assert.equal(deriveCanonicalPlayerId(result.issuer, result.subject), deriveCanonicalPlayerId(result.issuer, result.subject));
  assert.equal('email' in result, false, 'PII claims are not returned to game/session code.');
});

test('caches trusted JWKS keys across verification requests', async () => {
  const key = makeKey();
  const counter = { count: 0 };
  const verifier = createOidcVerifier({
    issuer: ISSUER, audience: AUDIENCE, jwksUrl: JWKS_URL,
    fetchImpl: fakeFetch([key.jwk], counter), clock: () => NOW,
  });
  const token = makeToken(key);
  await verifier.verifyToken(token);
  await verifier.verifyToken(token);
  assert.equal(counter.count, 1);
});

test('refreshes trusted JWKS once when an unknown key ID is encountered', async () => {
  const oldKey = makeKey('old-key');
  const newKey = makeKey('rotated-key');
  const counter = { count: 0 };
  const verifier = createOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: JWKS_URL,
    fetchImpl: async () => {
      counter.count += 1;
      const keys = counter.count === 1 ? [oldKey.jwk] : [newKey.jwk];
      return { ok: true, async text() { return JSON.stringify({ keys }); } };
    },
    clock: () => NOW,
  });
  const claims = await verifier.verifyToken(makeToken(newKey));
  assert.equal(claims.subject, 'subject-123');
  assert.equal(counter.count, 2);
});

test('rejects a token whose RSA signature is invalid', async () => {
  const trusted = makeKey('trusted-key');
  const attacker = makeKey('attacker-key');
  const verifier = makeVerifier([trusted.jwk]);
  await assert.rejects(verifier.verifyToken(makeToken({ ...attacker, kid: trusted.kid })), /signature verification failed/);
});

test('rejects wrong issuer and audience', async () => {
  const key = makeKey();
  const verifier = makeVerifier([key.jwk]);
  await assert.rejects(
    verifier.verifyToken(makeToken(key, { iss: 'https://attacker.example/' })),
    /issuer does not match/,
  );
  await assert.rejects(
    verifier.verifyToken(makeToken(key, { aud: 'another-api' })),
    /audience does not match/,
  );
});

test('rejects expired, not-yet-active and invalid issued-at tokens', async () => {
  const key = makeKey();
  const verifier = makeVerifier([key.jwk]);
  await assert.rejects(
    verifier.verifyToken(makeToken(key, { exp: Math.floor(NOW / 1000) - 1 })),
    /expired or has no expiry/,
  );
  await assert.rejects(
    verifier.verifyToken(makeToken(key, { nbf: Math.floor(NOW / 1000) + 30 })),
    /not active yet/,
  );
  await assert.rejects(
    verifier.verifyToken(makeToken(key, { iat: Math.floor(NOW / 1000) + 120 })),
    /invalid issued-at time/,
  );
});

test('requires bearer authorization and a valid compact RS256 token', async () => {
  const key = makeKey();
  const verifier = makeVerifier([key.jwk]);
  await assert.rejects(verifier.verifyAuthorizationHeader('Basic abc'), /Bearer token/);
  await assert.rejects(verifier.verifyToken('not-a-jwt'), /compact signed JWT/);
  await assert.rejects(verifier.verifyToken('a.b.c'), /invalid header JSON/);
  await assert.rejects(
    verifier.verifyToken(makeToken(key, {}, { alg: 'none' })),
    /must use a configured RS256/,
  );
});

test('rejects unsupported remote-key and critical JWT header parameters', async () => {
  const key = makeKey();
  const verifier = makeVerifier([key.jwk]);
  await assert.rejects(
    verifier.verifyToken(makeToken(key, {}, { jku: 'https://attacker.example/keys.json' })),
    /unsupported key or critical header/,
  );
  await assert.rejects(
    verifier.verifyToken(makeToken(key, {}, { crit: ['b64'] })),
    /unsupported key or critical header/,
  );
});

test('requires HTTPS issuer and JWKS URLs and bounded verifier settings', () => {
  assert.throws(
    () => createOidcVerifier({ issuer: 'http://identity.example/', audience: AUDIENCE, jwksUrl: JWKS_URL }),
    /HTTPS issuer/,
  );
  assert.throws(
    () => createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://identity.example/jwks' }),
    /must use HTTPS/,
  );
  assert.throws(
    () => createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUrl: JWKS_URL, cacheMs: 100 }),
    /cacheMs/,
  );
});

test('canonical player ID is issuer-scoped and rejects missing identity claims', () => {
  const id = deriveCanonicalPlayerId(ISSUER, 'subject-123');
  assert.equal(id.length, 69);
  assert.notEqual(id, deriveCanonicalPlayerId('https://another-issuer.example/', 'subject-123'));
  assert.throws(() => deriveCanonicalPlayerId('', 'subject-123'), /issuer and subject/);
  assert.throws(() => deriveCanonicalPlayerId(ISSUER, ''), /issuer and subject/);
});


test('permits HTTP JWKS only for an explicitly enabled loopback development verifier', () => {
  assert.throws(
    () => createOidcVerifier({
      issuer: ISSUER, audience: AUDIENCE, jwksUrl: 'http://127.0.0.1:9001/jwks',
    }),
    /HTTPS except for explicit loopback-only development tests/,
  );
  assert.doesNotThrow(() => createOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: 'http://127.0.0.1:9001/jwks',
    allowHttpForDevelopment: true,
  }));
  assert.throws(
    () => createOidcVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: 'http://attacker.example/jwks',
      allowHttpForDevelopment: true,
    }),
    /HTTPS except for explicit loopback-only development tests/,
  );
});


test('rejects missing issued-at claims and RSA signing keys below 2048 bits', async () => {
  const validKey = makeKey();
  const verifier = makeVerifier([validKey.jwk]);
  await assert.rejects(
    verifier.verifyToken(makeToken(validKey, { iat: undefined })),
    /invalid issued-at time/,
  );

  const weakPair = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const weakJwk = { ...weakPair.publicKey.export({ format: 'jwk' }), kid: 'weak-key', use: 'sig', alg: 'RS256' };
  const weakVerifier = makeVerifier([weakJwk]);
  const weakToken = makeToken({ kid: 'weak-key', privateKey: weakPair.privateKey }, {});
  await assert.rejects(weakVerifier.verifyToken(weakToken), /no supported RS256 keys/);
});
