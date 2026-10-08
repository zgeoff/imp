import { readFileSync, writeFileSync } from 'node:fs';
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

// A `gh` for an install script's provenance check: `auth status` and
// `attestation …` succeed or fail as configured, every other command
// succeeds, and each call's arguments are recorded beside the script.
export function createStubGhAttestation(options: StubGhAttestationOptions): StubGhAttestation {
  const log = join(options.bin, 'gh.calls');

  writeFileSync(log, '');

  writeFileSync(
    join(options.bin, 'gh'),
    [
      '#!/bin/sh',
      `echo "$*" >> '${log}'`,
      `[ "$1 $2" = "auth status" ] && exit ${options.loggedIn ? '0' : '1'}`,
      `[ "$1" = attestation ] && exit ${options.verifies ? '0' : '1'}`,
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  return {
    readCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
