import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '@imp/test-utils/wait-for';

// An `mkfs.ext4` in `<dir>/bin` that holds each rootfs write until `release`
// (the real one runs) or `fail` (that stderr), so a test acts while impd
// writes a rootfs; it gives up once `dir` is gone.
export function buildStubImageMkfs(dir: string) {
  const bin = join(dir, 'bin');
  const started = join(dir, 'mkfs-started');
  const released = join(dir, 'mkfs-released');

  // the real mkfs.ext4, which sits in sbin on most hosts
  const real =
    Bun.which('mkfs.ext4', { PATH: `${process.env['PATH'] ?? ''}:/usr/sbin:/sbin` }) ?? 'mkfs.ext4';

  const script = [
    '#!/bin/sh',
    `touch '${started}'`,
    `while [ ! -e '${released}' ]; do [ -d '${dir}' ] || exit 1; sleep 0.05; done`,
    `[ -s '${released}' ] && { cat '${released}' >&2; exit 1; }`,
    `exec '${real}' "$@"`,
    '',
  ].join('\n');

  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'mkfs.ext4'), script);
  chmodSync(join(bin, 'mkfs.ext4'), 0o755);

  return {
    bin,

    // resolves once a rootfs write has started
    waitForStart: () =>
      waitFor(() => {
        if (!existsSync(started)) {
          throw new Error('mkfs.ext4 has not started');
        }
      }),
    release: () => {
      writeFileSync(released, '');
    },
    fail: (stderr: string) => {
      writeFileSync(released, `${stderr}\n`);
    },
  };
}
