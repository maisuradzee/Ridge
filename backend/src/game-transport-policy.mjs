import { RidgeError } from './game-service.mjs';

// This remains false until the complete per-connection handshake and runtime
// acceptance suite pass on supported UE 5.8 platforms. Do not enable via env.
export const GAME_TRANSPORT_ENCRYPTION_RUNTIME_VERIFIED = false;

/**
 * Reports whether player sessions may be admitted in the current environment.
 * API/control-plane health is intentionally separate: Production can keep its
 * management plane available while public gameplay admission remains blocked.
 */
export function getGameTransportReadiness({
  environment = 'development',
  runtimeVerified = GAME_TRANSPORT_ENCRYPTION_RUNTIME_VERIFIED,
} = {}) {
  const encryptionRuntimeVerified = runtimeVerified === true;
  const gameSessionsEnabled = environment !== 'production' || encryptionRuntimeVerified;
  return {
    status: gameSessionsEnabled ? 'enabled' : 'blocked',
    gameSessionsEnabled,
    encryptionRuntimeVerified,
    ...(gameSessionsEnabled ? {} : {
      reasonCode: 'GAME_TRANSPORT_ENCRYPTION_NOT_READY',
    }),
  };
}

export function assertGameTransportReady(options = {}) {
  const readiness = getGameTransportReadiness(options);
  if (!readiness.gameSessionsEnabled) {
    throw new RidgeError(
      503,
      'GAME_TRANSPORT_ENCRYPTION_NOT_READY',
      'Production game sessions are disabled until per-connection encrypted transport passes runtime acceptance.',
    );
  }
}
