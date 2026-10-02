import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', '..', 'install.sh');
const OS = process.platform === 'darwin' ? 'darwin' : 'linux';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const ASSET = `imp-${OS}-${ARCH}`;

interface Release {
  readonly binary: string;
  readonly sums: string;
}

// a stand-in for the binary: prints the version as `imp --version` does
function makeBinary(version: string): string {
  return `#!/bin/sh\necho ${version}\n`;
}

function makeSums(binary: string): string {
  return `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  ${ASSET}\n`;
}

// GitHub's releases page: /latest redirects to the newest tag, and assets
// sit under /download/<tag>/
function setupTest(releases: Readonly<Record<string, Release>>, latest = 'v1.2.3') {
  const dir = mkdtempSync(join(tmpdir(), 'imp-install-'));
  const requests: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;

      const download = /^\/download\/(?<tag>[^/]+)\/(?<file>[^/]+)$/.exec(path)?.groups;
      const release = releases[download?.['tag'] ?? ''];

      requests.push(path);

      if (path === '/latest') {
        return Response.redirect(`/tag/${latest}`, 302);
      }

      if (path.startsWith('/tag/')) {
        return new Response('release page');
      }

      if (release !== undefined && download?.['file'] === ASSET) {
        return new Response(release.binary);
      }

      if (release !== undefined && download?.['file'] === 'SHA256SUMS') {
        return new Response(release.sums);
      }

      return new Response('not found', { status: 404 });
    },
  });

  // a gh that is logged in and records what it was asked; GH_VERIFY_FAILS
  // makes the attestation check fail
  const bin = join(dir, 'bin');
  const ghLog = join(dir, 'gh.log');

  mkdirSync(bin);

  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$*" >> '${ghLog}'\n[ "$1" = attestation ] && [ -n "\${GH_VERIFY_FAILS:-}" ] && exit 1\nexit 0\n`,
    { mode: 0o755 },
  );

  return {
    target: join(dir, 'install'),
    requests,
    readGhLog: () => (existsSync(ghLog) ? readFileSync(ghLog, 'utf8') : ''),

    // async: a spawnSync would block the server this process runs
    run: async (env: Readonly<Record<string, string>> = {}) => {
      const child = Bun.spawn(['sh', SCRIPT], {
        env: {
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          HOME: dir,
          IMP_RELEASES_URL: `http://localhost:${String(server.port)}`,
          IMP_INSTALL_DIR: join(dir, 'install'),
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      return { stdout, stderr, code };
    },
    [Symbol.asyncDispose]: async () => {
      await server.stop(true);

      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const V123 = { binary: makeBinary('1.2.3'), sums: makeSums(makeBinary('1.2.3')) };

test('it installs the latest release after checking its checksum and provenance', async () => {
  await using ctx = setupTest({ 'v1.2.3': V123 });

  const result = await ctx.run();

  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`imp: installed 1.2.3 to ${ctx.target}/imp`);

  expect(ctx.requests).toEqual([
    '/latest',
    '/tag/v1.2.3',
    `/download/v1.2.3/${ASSET}`,
    '/download/v1.2.3/SHA256SUMS',
  ]);

  expect(ctx.readGhLog()).toContain(`attestation verify`);
  expect(readFileSync(join(ctx.target, 'imp'), 'utf8')).toBe(V123.binary);
});

test('IMP_INSTALL_VERSION picks the release without asking for the latest', async () => {
  await using ctx = setupTest({
    'v1.0.0': { binary: makeBinary('1.0.0'), sums: makeSums(makeBinary('1.0.0')) },
  });

  const result = await ctx.run({ IMP_INSTALL_VERSION: '1.0.0' });

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('imp: installed 1.0.0');
  expect(ctx.requests).not.toContain('/latest');
});

test('a checksum mismatch installs nothing', async () => {
  await using ctx = setupTest({ 'v1.2.3': { binary: V123.binary, sums: makeSums('other') } });

  const result = await ctx.run();

  expect(result.code).toBe(1);

  expect(result.stderr).toBe(
    `imp: ${ASSET} does not match SHA256SUMS for v1.2.3; nothing installed\n`,
  );

  expect(existsSync(join(ctx.target, 'imp'))).toBeFalse();
});

test('a failed provenance check installs nothing', async () => {
  await using ctx = setupTest({ 'v1.2.3': V123 });

  const result = await ctx.run({ GH_VERIFY_FAILS: '1' });

  expect(result.code).toBe(1);

  expect(result.stderr).toBe(
    `imp: ${ASSET} has no valid provenance from zgeoff/imp; nothing installed\n`,
  );

  expect(existsSync(join(ctx.target, 'imp'))).toBeFalse();
});

test('no release at all is an error', async () => {
  await using ctx = setupTest({}, '');

  const result = await ctx.run();

  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith('imp: no release found at');
});
