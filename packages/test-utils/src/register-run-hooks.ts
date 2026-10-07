import { afterEach } from 'bun:test';
import { removeEnvOverrides } from './remove-env-overrides';
import { setFakerSeed } from './set-faker-seed';

// The resets every run needs, with or without the MSW server: a seeded faker,
// and every env override put back after each test.
export function registerRunHooks(): void {
  setFakerSeed();

  afterEach(() => {
    removeEnvOverrides();
  });
}
