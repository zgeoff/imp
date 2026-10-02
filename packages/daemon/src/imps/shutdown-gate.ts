import { buildStoppingError } from '../api-errors';

// Closed once impd puts every imp to sleep to stop: no VM starts after that,
// since it would outlive impd's last sleep pass.
export interface ShutdownGate {
  readonly close: () => void;

  // throws SERVICE_UNAVAILABLE once the gate is closed
  readonly requireOpen: () => void;
}

export function createShutdownGate(): ShutdownGate {
  const state = { closed: false };

  return {
    close: () => {
      state.closed = true;
    },
    requireOpen: () => {
      if (state.closed) {
        throw buildStoppingError();
      }
    },
  };
}
