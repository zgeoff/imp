import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as z from 'zod';

// deploy/imp-host.seccomp.json is Docker's default profile from moby/profiles at this commit
// (seccomp/default.json), plus PIVOT_ROOT. To follow upstream, fetch the new file, append
// PIVOT_ROOT to its syscalls, and update both constants (docs/architecture/host-contract.md).
const UPSTREAM_COMMIT = '6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef';

// sha256 of JSON.stringify of the upstream file, so formatting does not count
const UPSTREAM_SHA256 = '3e30a4b18c1cab37399d130ba2abfbaa15827f1db45c451253314c635f57907d';

// the jailer's pivot_root, which the default profile denies even with CAP_SYS_ADMIN
const PIVOT_ROOT = {
  names: ['pivot_root'],
  action: 'SCMP_ACT_ALLOW',
  includes: { caps: ['CAP_SYS_ADMIN'] },
};

const ProfileSchema = z.looseObject({ syscalls: z.array(z.unknown()) });

test(`the profile is moby/profiles ${UPSTREAM_COMMIT.slice(0, 7)} plus pivot_root`, () => {
  const text = readFileSync(new URL('../deploy/imp-host.seccomp.json', import.meta.url), 'utf8');

  // parsed twice: zod's output moves syscalls first, and the digest needs upstream's key order
  const syscalls = ProfileSchema.parse(JSON.parse(text)).syscalls;
  const raw: unknown = JSON.parse(text);
  const added = syscalls.at(-1);
  const upstream = { ...z.looseObject({}).parse(raw), syscalls: syscalls.slice(0, -1) };

  const digest = new Bun.CryptoHasher('sha256').update(JSON.stringify(upstream)).digest('hex');

  expect(added).toEqual(PIVOT_ROOT);
  expect(digest).toBe(UPSTREAM_SHA256);
});
