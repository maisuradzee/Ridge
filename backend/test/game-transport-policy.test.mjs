import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  GAME_TRANSPORT_ENCRYPTION_RUNTIME_VERIFIED,
  assertGameTransportReady,
} from '../src/game-transport-policy.mjs';

const backendDir = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('development sessions remain available while game transport work is in progress', () => {
  assert.equal(GAME_TRANSPORT_ENCRYPTION_RUNTIME_VERIFIED, false);
  assert.doesNotThrow(() => assertGameTransportReady({ environment: 'development' }));
  assert.doesNotThrow(() => assertGameTransportReady({ environment: 'test' }));
});

test('production game sessions fail closed until encrypted transport runtime acceptance is enabled in source', () => {
  assert.throws(
    () => assertGameTransportReady({ environment: 'production' }),
    (error) => error.status === 503 &&
      error.code === 'GAME_TRANSPORT_ENCRYPTION_NOT_READY',
  );
});

test('the production policy only passes when runtime verification is explicitly true', () => {
  assert.doesNotThrow(() => assertGameTransportReady({
    environment: 'production',
    runtimeVerified: true,
  }));
  assert.throws(
    () => assertGameTransportReady({
      environment: 'production',
      runtimeVerified: false,
    }),
    (error) => error.code === 'GAME_TRANSPORT_ENCRYPTION_NOT_READY',
  );
});

test('public Gateway applies the transport gate before OIDC ticket allocation', async () => {
  const source = await readFile(path.join(backendDir, 'src/server.mjs'), 'utf8');
  const routeStart = source.indexOf("if (request.method === 'POST' && url.pathname === '/v1/gateway/session')");
  assert.notEqual(routeStart, -1);
  const routeEnd = source.indexOf("if (request.method === 'GET' && url.pathname === '/v1/world/state')", routeStart);
  assert.notEqual(routeEnd, -1);
  const route = source.slice(routeStart, routeEnd);
  const gate = route.indexOf('assertGameTransportReady({ environment: ENV });');
  const oidc = route.indexOf('oidcVerifier.verifyAuthorizationHeader');
  const allocation = route.indexOf('sessionRegistry.allocatePlayer');
  const ticket = route.indexOf('sessionRegistry.issueJoinTicket');
  assert.ok(gate >= 0, 'Gateway route must include the game transport gate.');
  assert.ok(oidc > gate, 'Transport policy must run before verifying account identity.');
  assert.ok(allocation > gate, 'No player session may be allocated before transport readiness.');
  assert.ok(ticket > gate, 'No join ticket may be issued before transport readiness.');
});
