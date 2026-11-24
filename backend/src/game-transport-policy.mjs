import { RidgeError } from './game-service.mjs';

// This remains false until the complete per-connection handshake and runtime
// acceptance suite pass on supported UE 5.8 platforms. Do not enable via env.
export const GAME_TRANSPORT_ENCRYPTION_RUNTIME_VERIFIED = false;

export function assertGameTransportReady({
  environment = 'development',
  runtimeVerified = GAME_TRANSPORT_ENCRYPTION_RUNTIME_VERIFIED,
} = {}) {
  if (environment === 'production' && runtimeVerified !== true) {
    throw new RidgeError(
      503,
      'GAME_TRANSPORT_ENCRYPTION_NOT_READY',
      'Production game sessions are disabled until per-connection encrypted transport passes runtime acceptance.',
    );
  }
}
