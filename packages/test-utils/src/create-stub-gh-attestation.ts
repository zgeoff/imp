import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface StubGhAttestationOptions {
  // the directory the `gh` script goes in, ahead of the real one on PATH
  readonly bin: string;

  // whether `gh auth status` succeeds
  readonly loggedIn: boolean;

  // whether `gh attestation verify` succeeds
  readonly verifies: boolean;
}

export interface StubGhAttestation {
  // the arguments of each call, in order
  readonly readCalls: () => readonly string[];
}

// A `gh` for an install script's provenance check (run-stub-gh-attestation.sh):
// `auth status` and `attestation …` succeed or fail as configured, every other
// command succeeds, and each call's arguments are recorded beside the script.
export function createStubGhAttestation(options: StubGhAttestationOptions): StubGhAttestation {
  const log = join(options.bin, 'gh.calls');
  const authStatus = options.loggedIn ? '0\n' : '1\n';
  const attestation = options.verifies ? '0\n' : '1\n';

  writeFileSync(log, '');
  writeFileSync(join(options.bin, 'gh.auth-status'), authStatus);
  writeFileSync(join(options.bin, 'gh.attestation'), attestation);
  copyFileSync(join(import.meta.dir, 'run-stub-gh-attestation.sh'), join(options.bin, 'gh'));
  chmodSync(join(options.bin, 'gh'), 0o755);

  return {
    readCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
