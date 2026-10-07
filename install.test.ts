import { expect, test } from 'bun:test';
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
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-install-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the stubs go here, ahead of the real commands on PATH
  const bin = join(dir, 'bin');

  mkdirSync(bin);

  const owned = stack.move();

  return {
    dir,
    bin,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it installs the latest release after checking its checksum and provenance', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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
    requests: releases.requests,
    ghCalls: gh.readCalls(),
    installed: readFileSync(join(ctx.dir, 'install', 'imp'), 'utf8'),
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
    requests: [
      '/latest',
      '/tag/v1.2.3',
      '/download/v1.2.3/imp-linux-x64',
      '/download/v1.2.3/SHA256SUMS',
    ],
    ghCalls: [
      'auth status',
      expect.stringMatching(/^attestation verify \S+\/imp-linux-x64 -R zgeoff\/imp$/u),
    ],
    installed: binary,
  });
});

test('it installs the release IMP_INSTALL_VERSION names without asking for the latest', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.0.0\n';

  await using releases = startStubGithubReleases({
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

  expect({
    stdout: result.stdout.toString(),
    exitCode: result.exitCode,
    requests: releases.requests,
  }).toStrictEqual({
    stdout: [
      'imp: downloading imp-linux-x64 v1.0.0',
      'imp: provenance verified',
      `imp: installed 1.0.0 to ${ctx.dir}/install/imp`,
      `imp: add ${ctx.dir}/install to your PATH`,
      '',
    ].join('\n'),
    exitCode: 0,
    requests: ['/download/v1.0.0/imp-linux-x64', '/download/v1.0.0/SHA256SUMS'],
  });
});

test('it installs the release a v-prefixed IMP_INSTALL_VERSION names', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.0.0\n';

  await using releases = startStubGithubReleases({
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

  expect({
    stdout: result.stdout.toString(),
    exitCode: result.exitCode,
    requests: releases.requests,
  }).toStrictEqual({
    stdout: [
      'imp: downloading imp-linux-x64 v1.0.0',
      'imp: provenance verified',
      `imp: installed 1.0.0 to ${ctx.dir}/install/imp`,
      `imp: add ${ctx.dir}/install to your PATH`,
      '',
    ].join('\n'),
    exitCode: 0,
    requests: ['/download/v1.0.0/imp-linux-x64', '/download/v1.0.0/SHA256SUMS'],
  });
});

test('it installs without a provenance check when gh is not on PATH', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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

  expect({
    exitCode: result.exitCode,
    shasumCalls: shasum.readCalls(),
    installed: readFileSync(join(ctx.dir, 'install', 'imp'), 'utf8'),
  }).toStrictEqual({
    exitCode: 0,
    shasumCalls: [expect.stringMatching(/^-a 256 \S+\/imp-linux-x64$/u)],
    installed: binary,
  });
});

test('it leaves out the PATH hint when the install dir is already on PATH', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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

  expect({
    exitCode: result.exitCode,
    installed: readFileSync(join(ctx.dir, 'install', 'imp'), 'utf8'),
  }).toStrictEqual({ exitCode: 0, installed: binary });
});

test('it installs nothing when the binary does not match SHA256SUMS', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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
    installed: existsSync(join(ctx.dir, 'install', 'imp')),
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\n',
    stderr: 'imp: imp-linux-x64 does not match SHA256SUMS for v1.2.3; nothing installed\n',
    exitCode: 1,
    installed: false,
  });
});

test('it installs nothing when SHA256SUMS lists no binary for the platform', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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
    installed: existsSync(join(ctx.dir, 'install', 'imp')),
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\n',
    stderr: 'imp: SHA256SUMS for v1.2.3 lists no imp-linux-x64\n',
    exitCode: 1,
    installed: false,
  });
});

test('it installs nothing when the provenance check fails', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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
    installed: existsSync(join(ctx.dir, 'install', 'imp')),
  }).toStrictEqual({
    stdout: 'imp: downloading imp-linux-x64 v1.2.3\n',
    stderr:
      'imp: could not verify provenance of imp-linux-x64 from zgeoff/imp; nothing installed\n',
    exitCode: 1,
    installed: false,
  });
});

test('it skips the provenance check when gh is not logged in', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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
    ghCalls: gh.readCalls(),
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
    ghCalls: ['auth status'],
  });
});

test('it fails the install when the binary does not run', async () => {
  using ctx = setupTest();

  const binary = '#!/bin/sh\nexit 1\n';

  await using releases = startStubGithubReleases({
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
  using ctx = setupTest();

  await using releases = startStubGithubReleases({ latest: null, assets: {} });

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
  using ctx = setupTest();

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
  using ctx = setupTest();

  await using releases = startStubGithubReleases({
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
  using ctx = setupTest();

  const binary = '#!/bin/sh\necho 1.2.3\n';

  await using releases = startStubGithubReleases({
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
  using ctx = setupTest();

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
  using ctx = setupTest();

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
