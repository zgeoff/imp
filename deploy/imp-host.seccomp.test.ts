import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as z from 'zod';

// Docker's default profile, moby/profiles 6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef
// seccomp/default.json, plus pivot_root. To follow upstream, append the rule to the new file
// and update the commit and the digest here (docs/architecture/host-contract.md).
test('it is the moby/profiles default profile at 6fe7deb plus pivot_root', () => {
  const text = readFileSync(new URL('imp-host.seccomp.json', import.meta.url), 'utf8');

  // parsed twice: zod's output moves syscalls first, and the digest needs upstream's key order
  const syscalls = z
    .looseObject({ syscalls: z.array(z.unknown()) })
    .parse(JSON.parse(text)).syscalls;

  const upstream = {
    ...z.looseObject({}).parse(JSON.parse(text)),
    syscalls: syscalls.slice(0, -1),
  };

  // sha256 of JSON.stringify of the upstream file, so formatting does not count
  expect(new Bun.CryptoHasher('sha256').update(JSON.stringify(upstream)).digest('hex')).toBe(
    '3e30a4b18c1cab37399d130ba2abfbaa15827f1db45c451253314c635f57907d',
  );

  // the jailer's pivot_root, which the default profile denies even with CAP_SYS_ADMIN
  expect(syscalls.at(-1)).toStrictEqual({
    names: ['pivot_root'],
    action: 'SCMP_ACT_ALLOW',
    includes: { caps: ['CAP_SYS_ADMIN'] },
  });
});
