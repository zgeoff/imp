import { envOriginals } from './env-originals';

// Overrides an environment variable for the rest of the test, or unsets it
// for `undefined`; the preload puts back the value it held before the test.
export function updateEnv(key: string, value: string | undefined): void {
  if (!envOriginals.has(key)) {
    envOriginals.set(key, process.env[key]);
  }

  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
