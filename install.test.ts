import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { createCommandLinks } from './packages/test-utils/src/create-command-links';
import { createStubGhAttestation } from './packages/test-utils/src/create-stub-gh-attestation';
import { createStubShasum } from './packages/test-utils/src/create-stub-shasum';
import { createStubUname } from './packages/test-utils/src/create-stub-uname';
import { startStubGithubReleases } from './packages/test-utils/src/start-stub-github-releases';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-install-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the stubs go here, ahead of the real commands on PATH
  const bin = join(dir, 'bin');

  mkdirSync(bin);

  return { dir, bin };
}

test('it installs the latest release after checking its checksum and provenance', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });

  const gh = createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: [
      'imp: downloading imp-linux-x64 v1.2.3',
      'imp: provenance verified',
      `imp: installed 1.2.3 to ${ctx.dir}/install/imp`,
      `imp: add ${ctx.dir}/install to your PATH`,
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  });

  expect(releases.requests).toStrictEqual([
    '/latest',
    '/tag/v1.2.3',
    '/download/v1.2.3/imp-linux-x64',
    '/download/v1.2.3/SHA256SUMS',
  ]);

  expect(gh.readCalls()).toStrictEqual([
    'auth status',
    expect.stringMatching(/^attestation verify \S+\/imp-linux-x64 -R zgeoff\/imp$/u),
  ]);

  expect(readFileSync(join(ctx.dir, 'install', 'imp'), 'utf8')).toBe(binary);
});

test('it installs the release IMP_INSTALL_VERSION names without asking for the latest', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.0.0\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.0.0/imp-linux-x64': binary,
      'v1.0.0/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
      IMP_INSTALL_VERSION: '1.0.0',
    })
    .nothrow()
    .quiet();

  expect({ stdout: result.stdout.toString(), exitCode: result.exitCode }).toStrictEqual({
    stdout: [
      'imp: downloading imp-linux-x64 v1.0.0',
      'imp: provenance verified',
      `imp: installed 1.0.0 to ${ctx.dir}/install/imp`,
      `imp: add ${ctx.dir}/install to your PATH`,
      '',
    ].join('\n'),
    exitCode: 0,
  });

  expect(releases.requests).toStrictEqual([
    '/download/v1.0.0/imp-linux-x64',
    '/download/v1.0.0/SHA256SUMS',
  ]);
});

test('it installs the release a v-prefixed IMP_INSTALL_VERSION names', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.0.0\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.0.0/imp-linux-x64': binary,
      'v1.0.0/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
      IMP_INSTALL_VERSION: 'v1.0.0',
    })
    .nothrow()
    .quiet();

  expect({ stdout: result.stdout.toString(), exitCode: result.exitCode }).toStrictEqual({
    stdout: [
      'imp: downloading imp-linux-x64 v1.0.0',
      'imp: provenance verified',
      `imp: installed 1.0.0 to ${ctx.dir}/install/imp`,
      `imp: add ${ctx.dir}/install to your PATH`,
      '',
    ].join('\n'),
    exitCode: 0,
  });

  expect(releases.requests).toStrictEqual([
    '/download/v1.0.0/imp-linux-x64',
    '/download/v1.0.0/SHA256SUMS',
  ]);
});

test('it installs without a provenance check when gh is not on PATH', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createCommandLinks({
    bin: ctx.bin,
    names: ['sh', 'curl', 'awk', 'sha256sum', 'cut', 'mktemp', 'rm', 'mkdir', 'cp', 'chmod', 'mv'],
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: ctx.bin,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: [
      'imp: downloading imp-linux-x64 v1.2.3',
      `imp: installed 1.2.3 to ${ctx.dir}/install/imp`,
      `imp: add ${ctx.dir}/install to your PATH`,
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  });
});

test('it checks the binary with shasum when sha256sum is not on PATH', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createCommandLinks({
    bin: ctx.bin,
    names: ['sh', 'curl', 'awk', 'cut', 'mktemp', 'rm', 'mkdir', 'cp', 'chmod', 'mv'],
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const shasum = createStubShasum({ bin: ctx.bin });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: ctx.bin,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(shasum.readCalls()).toStrictEqual([expect.stringMatching(/^-a 256 \S+\/imp-linux-x64$/u)]);
  expect(readFileSync(join(ctx.dir, 'install', 'imp'), 'utf8')).toBe(binary);
});

test('it leaves out the PATH hint when the install dir is already on PATH', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${join(ctx.dir, 'install')}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({ stdout: result.stdout.toString(), exitCode: result.exitCode }).toStrictEqual({
    stdout: [
      'imp: downloading imp-linux-x64 v1.2.3',
      'imp: provenance verified',
      `imp: installed 1.2.3 to ${ctx.dir}/install/imp`,
      '',
    ].join('\n'),
    exitCode: 0,
  });
});

test('it installs the binary for the platform uname names', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-darwin-arm64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-darwin-arm64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Darwin', machine: 'aarch64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(ctx.dir, 'install', 'imp'), 'utf8')).toBe(binary);
});

test('it installs nothing when the binary does not match SHA256SUMS', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update('other').digest('hex')}  imp-linux-x64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\n',
    stderr: 'imp: imp-linux-x64 does not match SHA256SUMS for v1.2.3; nothing installed\n',
    exitCode: 1,
  });

  expect(existsSync(join(ctx.dir, 'install', 'imp'))).toBeFalse();
});

test('it installs nothing when SHA256SUMS lists no binary for the platform', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-darwin-arm64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\n',
    stderr: 'imp: SHA256SUMS for v1.2.3 lists no imp-linux-x64\n',
    exitCode: 1,
  });

  expect(existsSync(join(ctx.dir, 'install', 'imp'))).toBeFalse();
});

test('it installs nothing when the provenance check fails', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: false });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\n',
    stderr:
      'imp: could not verify provenance of imp-linux-x64 from zgeoff/imp; nothing installed\n',
    exitCode: 1,
  });

  expect(existsSync(join(ctx.dir, 'install', 'imp'))).toBeFalse();
});

test('it skips the provenance check when gh is not logged in', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });

  const gh = createStubGhAttestation({ bin: ctx.bin, loggedIn: false, verifies: false });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: [
      'imp: downloading imp-linux-x64 v1.2.3',
      'imp: gh is not logged in; skipped the provenance check',
      `imp: installed 1.2.3 to ${ctx.dir}/install/imp`,
      `imp: add ${ctx.dir}/install to your PATH`,
      '',
    ].join('\n'),
    stderr: '',
    exitCode: 0,
  });

  expect(gh.readCalls()).toStrictEqual(['auth status']);
});

test('it fails the install when the binary does not run', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\nexit 1\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: {
      'v1.2.3/imp-linux-x64': binary,
      'v1.2.3/SHA256SUMS': `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-linux-x64\n`,
    },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\nimp: provenance verified\n',
    stderr: '',
    exitCode: 1,
  });
});

test('it fails when the repo has no release', async () => {
  const ctx = setupTest();
  const releases = startStubGithubReleases({ latest: null, assets: {} });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: '',
    stderr: `imp: no release found at ${releases.url} (got '')\n`,
    exitCode: 1,
  });
});

test('it fails when the releases page does not answer', async () => {
  const ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  // nothing listens on port 1
  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: 'http://127.0.0.1:1',
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: '',
    stderr: expect.toEndWith('imp: cannot reach http://127.0.0.1:1/latest\n'),
    exitCode: 1,
  });
});

test('it fails when the release has no binary to download', async () => {
  const ctx = setupTest();

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: { 'v1.2.3/SHA256SUMS': 'sums' },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\n',
    stderr: expect.toEndWith('imp: cannot download imp-linux-x64 v1.2.3\n'),
    exitCode: 1,
  });
});

test('it fails when the release has no SHA256SUMS to download', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 1.2.3\n';

  const releases = startStubGithubReleases({
    latest: 'v1.2.3',
    assets: { 'v1.2.3/imp-linux-x64': binary },
  });

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: releases.url,
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\n',
    stderr: expect.toEndWith('imp: cannot download SHA256SUMS for v1.2.3\n'),
    exitCode: 1,
  });
});

test('it fails on a system it has no binary for', async () => {
  const ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'FreeBSD', machine: 'x86_64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: 'http://127.0.0.1:1',
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({ stdout: '', stderr: 'imp: no binary for FreeBSD\n', exitCode: 1 });
});

test('it fails on a machine it has no binary for', async () => {
  const ctx = setupTest();

  createStubUname({ bin: ctx.bin, system: 'Linux', machine: 'riscv64' });
  createStubGhAttestation({ bin: ctx.bin, loggedIn: true, verifies: true });

  const result = await $`sh ${join(import.meta.dir, 'install.sh')}`
    .env({
      PATH: `${ctx.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      IMP_RELEASES_URL: 'http://127.0.0.1:1',
      IMP_INSTALL_DIR: join(ctx.dir, 'install'),
    })
    .nothrow()
    .quiet();

  expect({
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  }).toStrictEqual({ stdout: '', stderr: 'imp: no binary for riscv64\n', exitCode: 1 });
});
