import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionRegistry } from '../src/session-registry.mjs';

test('Dedicated Server credential issuance, rotation and revocation produce immutable-shaped audit events', async () => {
  const registry = await createSessionRegistry();
  const serverId = 'audit-shard-01';
  const actorId = 'test-ridge-orchestrator';

  const first = await registry.issueServerCredential({ serverId, actorId });
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  let events = await registry.listServerCredentialEvents({ serverId });
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'issued');
  assert.equal(events[0].credentialId, first.credentialId);
  assert.equal(events[0].previousCredentialId, null);

  const second = await registry.issueServerCredential({ serverId, actorId });
  assert.notEqual(second.token, first.token);
  assert.equal(await registry.authenticateServerCredential({ serverId, token: first.token }), false);
  assert.equal(await registry.authenticateServerCredential({ serverId, token: second.token }), true);

  events = await registry.listServerCredentialEvents({ serverId });
  assert.equal(events.length, 2);
  assert.equal(events[0].action, 'rotated');
  assert.equal(events[0].credentialId, second.credentialId);
  assert.equal(events[0].previousCredentialId, first.credentialId);

  const revoked = await registry.revokeServerCredential({ serverId, actorId });
  assert.deepEqual(revoked, { revoked: true, credentialId: second.credentialId });
  assert.equal(await registry.authenticateServerCredential({ serverId, token: second.token }), false);
  assert.deepEqual(await registry.revokeServerCredential({ serverId, actorId }), { revoked: false });

  events = await registry.listServerCredentialEvents({ serverId });
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.action), ['revoked', 'rotated', 'issued']);
  assert.ok(events.every((event) =>
    event.serverId === serverId &&
    event.actorType === 'service' &&
    event.actorId === actorId &&
    typeof event.eventId === 'string' &&
    typeof event.occurredAt === 'string' &&
    !Object.hasOwn(event, 'token') &&
    !Object.hasOwn(event, 'tokenHash') &&
    !Object.hasOwn(event, 'auditSequence')
  ));

  await assert.rejects(
    registry.listServerCredentialEvents({ serverId, limit: 0 }),
    (error) => error.code === 'INVALID_CREDENTIAL_AUDIT_LIMIT',
  );
  await assert.rejects(
    registry.listServerCredentialEvents({ serverId, limit: 101 }),
    (error) => error.code === 'INVALID_CREDENTIAL_AUDIT_LIMIT',
  );
  await assert.rejects(
    registry.issueServerCredential({ serverId, actorId: 'invalid actor id' }),
    (error) => error.code === 'INVALID_CREDENTIAL_ACTOR_ID',
  );
});

test('credential audit history is isolated by server ID and respects a bounded limit', async () => {
  const registry = await createSessionRegistry();
  const serverA = 'audit-shard-a';
  const serverB = 'audit-shard-b';
  const actorIdA = 'orchestrator-a';
  const actorIdB = 'orchestrator-b';

  await registry.issueServerCredential({ serverId: serverA, actorId: actorIdA });
  await registry.issueServerCredential({ serverId: serverA, actorId: actorIdA });
  await registry.issueServerCredential({ serverId: serverB, actorId: actorIdB });

  const aEvents = await registry.listServerCredentialEvents({ serverId: serverA, limit: 1 });
  const bEvents = await registry.listServerCredentialEvents({ serverId: serverB });
  assert.equal(aEvents.length, 1);
  assert.equal(aEvents[0].action, 'rotated');
  assert.equal(bEvents.length, 1);
  assert.equal(bEvents[0].action, 'issued');
  assert.equal(aEvents[0].actorId, actorIdA);
  assert.equal(bEvents[0].actorId, actorIdB);
});
