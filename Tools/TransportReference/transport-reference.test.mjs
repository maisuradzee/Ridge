import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey,
  createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes,
} from 'node:crypto';

const VERSION = 1;
const SUITE = 'X25519-HKDF-SHA256-AES-256-GCM';
const SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SALT_PREFIX = Buffer.from('RIDGE/TRANSPORT/V1/JOIN/SALT\0');
const INFO = Buffer.from('RIDGE/TRANSPORT/V1/X25519-HKDF-SHA256/AES-256-GCM/JOIN-ENVELOPE');
const MARKER = 'RIDGE_JOIN_ENVELOPE_V1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const fromHex = (hex) => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(hex, 'hex')]), format: 'der', type: 'pkcs8' });
const rawPublic = (key) => {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  if (!der.subarray(0, SPKI.length).equals(SPKI) || der.length !== SPKI.length + 32) fail('INVALID_PUBLIC_KEY');
  return der.subarray(SPKI.length).toString('base64url');
};
const pair = () => {
  const keys = generateKeyPairSync('x25519');
  return { publicKey: rawPublic(keys.privateKey), privateKey: keys.privateKey };
};
const decode = (value, code, length) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) fail(code);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) fail(code);
  return bytes;
};
const peerKey = (value) => createPublicKey({ key: Buffer.concat([SPKI, decode(value, 'INVALID_PUBLIC_KEY', 32)]), format: 'der', type: 'spki' });
const normalize = (x) => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail('INVALID_CONTEXT');
  for (const name of ['keyId', 'serverId', 'sessionId', 'claimAttemptId']) {
    if (typeof x[name] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x[name])) fail('INVALID_' + name.toUpperCase());
  }
  if (!Number.isSafeInteger(x.expiresAt) || x.expiresAt <= 0) fail('INVALID_EXPIRY');
  decode(x.clientPublicKey, 'INVALID_CLIENT_PUBLIC_KEY', 32);
  decode(x.serverPublicKey, 'INVALID_SERVER_PUBLIC_KEY', 32);
  return {
    protocolVersion: VERSION, suite: SUITE, keyId: x.keyId, serverId: x.serverId,
    sessionId: x.sessionId, claimAttemptId: x.claimAttemptId, expiresAt: x.expiresAt,
    clientPublicKey: x.clientPublicKey, serverPublicKey: x.serverPublicKey,
  };
};
const aadFor = (x) => {
  const c = normalize(x);
  return Buffer.from(JSON.stringify([
    'RIDGE_JOIN_AAD_V1', c.protocolVersion, c.suite, c.keyId, c.serverId,
    c.sessionId, c.claimAttemptId, c.expiresAt, c.clientPublicKey, c.serverPublicKey,
  ]));
};
const derive = ({ privateKey, peerPublicKey, context }) => {
  if (!privateKey || privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'x25519') fail('INVALID_PRIVATE_KEY');
  const c = normalize(context);
  const local = rawPublic(privateKey);
  const clientSide = local === c.clientPublicKey && peerPublicKey === c.serverPublicKey;
  const serverSide = local === c.serverPublicKey && peerPublicKey === c.clientPublicKey;
  if (!clientSide && !serverSide) fail('KEY_CONTEXT_MISMATCH');
  let shared;
  try { shared = diffieHellman({ privateKey, publicKey: peerKey(peerPublicKey) }); }
  catch { fail('INVALID_PEER_PUBLIC_KEY'); }
  try {
    const salt = createHash('sha256').update(SALT_PREFIX).update(aadFor(c)).digest();
    return Buffer.from(hkdfSync('sha256', shared, salt, INFO, 32));
  } finally { shared.fill(0); }
};
const seal = ({ serverPublicKey, keyId, serverId, sessionId, claimAttemptId, expiresAt, ticket }) => {
  const client = pair();
  const c = normalize({ keyId, serverId, sessionId, claimAttemptId, expiresAt, clientPublicKey: client.publicKey, serverPublicKey });
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || decode(ticket, 'INVALID_JOIN_TICKET', 32).length !== 32) fail('INVALID_JOIN_TICKET');
  const aad = aadFor(c);
  const key = derive({ privateKey: client.privateKey, peerPublicKey: serverPublicKey, context: c });
  const nonce = randomBytes(NONCE_BYTES);
  const plaintext = Buffer.from(JSON.stringify([MARKER, ticket, serverId, sessionId, claimAttemptId, expiresAt]));
  let ciphertext, tag;
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    tag = cipher.getAuthTag();
  } finally { plaintext.fill(0); key.fill(0); }
  return { ...c, nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: tag.toString('base64url') };
};
const open = ({ envelope: e, serverPrivateKey, expectedKeyId, expectedServerId, nowSeconds = Math.floor(Date.now() / 1000) }) => {
  if (!serverPrivateKey || serverPrivateKey.type !== 'private' || serverPrivateKey.asymmetricKeyType !== 'x25519') fail('INVALID_PRIVATE_KEY');
  const fields = ['protocolVersion', 'suite', 'keyId', 'serverId', 'sessionId', 'claimAttemptId', 'expiresAt', 'clientPublicKey', 'serverPublicKey', 'nonce', 'ciphertext', 'tag'].sort();
  if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).sort().join('|') !== fields.join('|')) fail('INVALID_ENVELOPE_FIELDS');
  if (e.protocolVersion !== VERSION || e.suite !== SUITE) fail('UNSUPPORTED_ENVELOPE_VERSION');
  if (e.keyId !== expectedKeyId) fail('KEY_ID_MISMATCH');
  if (e.serverId !== expectedServerId) fail('SERVER_ID_MISMATCH');
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) fail('INVALID_CLOCK');
  const c = normalize(e);
  if (c.expiresAt <= nowSeconds) fail('ENVELOPE_EXPIRED');
  if (rawPublic(serverPrivateKey) !== c.serverPublicKey) fail('SERVER_KEY_MISMATCH');
  const nonce = decode(e.nonce, 'INVALID_NONCE', NONCE_BYTES);
  const ciphertext = decode(e.ciphertext, 'INVALID_CIPHERTEXT');
  if (ciphertext.length === 0 || ciphertext.length > 1024) fail('INVALID_CIPHERTEXT');
  const tag = decode(e.tag, 'INVALID_TAG', TAG_BYTES);
  const key = derive({ privateKey: serverPrivateKey, peerPublicKey: c.clientPublicKey, context: c });
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadFor(c)); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch { fail('ENVELOPE_AUTH_FAILED'); }
  finally { key.fill(0); }
  let data;
  try { data = JSON.parse(plaintext.toString('utf8')); }
  catch { fail('INVALID_ENVELOPE_PLAINTEXT'); }
  finally { plaintext.fill(0); }
  if (!Array.isArray(data) || data.length !== 6 || data[0] !== MARKER) fail('INVALID_ENVELOPE_PLAINTEXT');
  const [marker, ticket, serverId, sessionId, claimAttemptId, expiresAt] = data;
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket) ||
      serverId !== c.serverId || sessionId !== c.sessionId ||
      claimAttemptId !== c.claimAttemptId || expiresAt !== c.expiresAt || marker !== MARKER) fail('ENVELOPE_CONTEXT_MISMATCH');
  return { ticket, serverId, sessionId, claimAttemptId, expiresAt, keyId: c.keyId };
};

const vector = {
  clientPrivateKeyHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  serverPrivateKeyHex: '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
  suite: SUITE, keyId: 'ridge-ci-x25519-20261124', serverId: 'ridge-shard-tbilisi-a',
  sessionId: '11111111-2222-4333-8444-555555555555', claimAttemptId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  expiresAt: 2000000000, clientPublicKey: 'j0DFrbaPJWJK5bIU6nZ6bslNgp09e14a0bpvPiE4KF8',
  serverPublicKey: 'NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ',
  aadSha256: 'f8384e2116207028d495660d6d4723c2a322f52c0b3674205e23fa89e398b69f',
  joinEnvelopeKeyHex: '4e2c34efba6599f1d7bc1e3265deaaed4c62108e6ccf58024300f112aa30fd73',
};
const vectorContext = () => ({
  keyId: vector.keyId, serverId: vector.serverId, sessionId: vector.sessionId,
  claimAttemptId: vector.claimAttemptId, expiresAt: vector.expiresAt,
  clientPublicKey: vector.clientPublicKey, serverPublicKey: vector.serverPublicKey,
});
const codeIs = (code) => (error) => error.code === code;
const ticket = Buffer.alloc(32, 0x42).toString('base64url');

test('X25519/HKDF-SHA256 known-answer vector derives the same 256-bit key on both sides', () => {
  const client = fromHex(vector.clientPrivateKeyHex), server = fromHex(vector.serverPrivateKeyHex);
  assert.equal(rawPublic(client), vector.clientPublicKey);
  assert.equal(rawPublic(server), vector.serverPublicKey);
  const aad = aadFor(vectorContext());
  assert.equal(createHash('sha256').update(aad).digest('hex'), vector.aadSha256);
  assert.equal(derive({ privateKey: client, peerPublicKey: vector.serverPublicKey, context: vectorContext() }).toString('hex'), vector.joinEnvelopeKeyHex);
  assert.equal(derive({ privateKey: server, peerPublicKey: vector.clientPublicKey, context: vectorContext() }).toString('hex'), vector.joinEnvelopeKeyHex);
});

test('X25519 key objects must match their authenticated AAD public keys', () => {
  const c = pair(), s = pair();
  const context = { keyId: 'key-context', serverId: 'shard-context', sessionId: 's-1', claimAttemptId: 'a-1', expiresAt: 2000000000, clientPublicKey: c.publicKey, serverPublicKey: s.publicKey };
  assert.throws(() => derive({ privateKey: c.privateKey, peerPublicKey: s.publicKey, context: { ...context, clientPublicKey: pair().publicKey } }), codeIs('KEY_CONTEXT_MISMATCH'));
  const low = Buffer.alloc(32).toString('base64url');
  assert.throws(() => derive({ privateKey: c.privateKey, peerPublicKey: low, context: { ...context, serverPublicKey: low } }), codeIs('INVALID_PEER_PUBLIC_KEY'));
});

test('join ticket is encrypted, omitted from cleartext fields and opens only for the assigned server', () => {
  const s = pair();
  const e = seal({ serverPublicKey: s.publicKey, keyId: 'key-01', serverId: 'shard-a', sessionId: 'session-1', claimAttemptId: 'attempt-1', expiresAt: 2000000000, ticket });
  assert.equal(e.protocolVersion, 1); assert.equal(e.suite, SUITE);
  assert.equal(Buffer.from(e.nonce, 'base64url').length, NONCE_BYTES);
  assert.equal(Buffer.from(e.tag, 'base64url').length, TAG_BYTES);
  assert.equal(Object.hasOwn(e, 'ticket'), false); assert.equal(JSON.stringify(e).includes(ticket), false);
  assert.deepEqual(open({ envelope: e, serverPrivateKey: s.privateKey, expectedKeyId: 'key-01', expectedServerId: 'shard-a', nowSeconds: 1999999000 }), {
    ticket, serverId: 'shard-a', sessionId: 'session-1', claimAttemptId: 'attempt-1', expiresAt: 2000000000, keyId: 'key-01',
  });
});

test('each envelope gets a fresh ephemeral client key and nonce', () => {
  const s = pair(), p = { serverPublicKey: s.publicKey, keyId: 'key-fresh', serverId: 'shard-fresh', sessionId: 'session-fresh', claimAttemptId: 'attempt-fresh', expiresAt: 2000000000, ticket };
  const a = seal(p), b = seal(p);
  assert.notEqual(a.clientPublicKey, b.clientPublicKey); assert.notEqual(a.nonce, b.nonce);
  assert.equal(open({ envelope: b, serverPrivateKey: s.privateKey, expectedKeyId: p.keyId, expectedServerId: p.serverId, nowSeconds: 1999999000 }).ticket, ticket);
});

test('tampered ciphertext and authenticated context fail closed', () => {
  const s = pair(), e = seal({ serverPublicKey: s.publicKey, keyId: 'key-tamper', serverId: 'shard-tamper', sessionId: 'session-tamper', claimAttemptId: 'attempt-tamper', expiresAt: 2000000000, ticket });
  const bytes = Buffer.from(e.ciphertext, 'base64url'); bytes[0] ^= 1;
  assert.throws(() => open({ envelope: { ...e, ciphertext: bytes.toString('base64url') }, serverPrivateKey: s.privateKey, expectedKeyId: e.keyId, expectedServerId: e.serverId, nowSeconds: 1999999000 }), codeIs('ENVELOPE_AUTH_FAILED'));
  assert.throws(() => open({ envelope: { ...e, sessionId: 'changed-session' }, serverPrivateKey: s.privateKey, expectedKeyId: e.keyId, expectedServerId: e.serverId, nowSeconds: 1999999000 }), codeIs('ENVELOPE_AUTH_FAILED'));
});

test('wrong key ID, server, private key and expired envelope are rejected', () => {
  const s = pair(), other = pair(), e = seal({ serverPublicKey: s.publicKey, keyId: 'key-guard', serverId: 'shard-guard', sessionId: 'session-guard', claimAttemptId: 'attempt-guard', expiresAt: 2000000000, ticket });
  const base = { envelope: e, serverPrivateKey: s.privateKey, expectedKeyId: e.keyId, expectedServerId: e.serverId, nowSeconds: 1999999000 };
  assert.throws(() => open({ ...base, expectedKeyId: 'wrong' }), codeIs('KEY_ID_MISMATCH'));
  assert.throws(() => open({ ...base, expectedServerId: 'wrong' }), codeIs('SERVER_ID_MISMATCH'));
  assert.throws(() => open({ ...base, serverPrivateKey: other.privateKey }), codeIs('SERVER_KEY_MISMATCH'));
  assert.throws(() => open({ ...base, nowSeconds: 2000000000 }), codeIs('ENVELOPE_EXPIRED'));
});

test('malformed fields and accidental cleartext ticket are rejected', () => {
  const s = pair(), e = seal({ serverPublicKey: s.publicKey, keyId: 'key-format', serverId: 'shard-format', sessionId: 'session-format', claimAttemptId: 'attempt-format', expiresAt: 2000000000, ticket });
  const base = { serverPrivateKey: s.privateKey, expectedKeyId: e.keyId, expectedServerId: e.serverId, nowSeconds: 1999999000 };
  assert.throws(() => open({ ...base, envelope: { ...e, ticket } }), codeIs('INVALID_ENVELOPE_FIELDS'));
  assert.throws(() => open({ ...base, envelope: { ...e, clientPublicKey: 'short' } }), codeIs('INVALID_CLIENT_PUBLIC_KEY'));
  assert.throws(() => open({ ...base, envelope: { ...e, nonce: 'AA' } }), codeIs('INVALID_NONCE'));
  assert.throws(() => open({ ...base, envelope: { ...e, ciphertext: '' } }), codeIs('INVALID_CIPHERTEXT'));
});


test('AES-256-GCM known-answer vector fixes ciphertext and authentication-tag bytes', () => {
  const c = vector;
  const aad = aadFor({
    keyId: c.keyId, serverId: c.serverId, sessionId: c.sessionId,
    claimAttemptId: c.claimAttemptId, expiresAt: c.expiresAt,
    clientPublicKey: c.clientPublicKey, serverPublicKey: c.serverPublicKey,
  });
  const nonce = Buffer.from('000102030405060708090a0b', 'hex');
  const plaintext = Buffer.from(JSON.stringify([
    MARKER, ticket, c.serverId, c.sessionId, c.claimAttemptId, c.expiresAt,
  ]));
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(c.joinEnvelopeKeyHex, 'hex'), nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  assert.equal(ciphertext.toString('hex'), '4780c675c582fc5b147dacd1642c530d8005d64c7bde9b5651f808885dbf928b3451215cc2de02cd18eee6b3d92031777448636c71939af53ca0f24a7ab0717b3161884a8fc08b20c61a70463eebea1bcd15967a812082d596c758fbc1cd49f6ef89b7f6e55fe2f42af089d68bc4e1d8e63312e3a9c407ae8de7caa8a6b5b8469a8a192e57bf72682cf9be81dddd6b6530d385c40777ec2575f2e093ddcf4442b4e935e50cfacdf2d4dd877dab61771cf8a625c80fa3b9249d');
  assert.equal(cipher.getAuthTag().toString('hex'), '4f5becd381159957858f7aa3148436d7');
});
