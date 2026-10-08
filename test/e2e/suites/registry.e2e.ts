import { afterAll, beforeAll, expect, test } from 'bun:test';
import { lookup } from 'node:dns/promises';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { createRegistryTrust } from '../lib/create-registry-trust';
import type { RegistryTrust } from '../lib/create-registry-trust';
import { runImp, tryImp } from '../lib/imp-cli';
import { REPO_ROOT, runChecked, runCommand, runDevScript } from '../lib/instance';
import { writeRegistryIndex } from '../lib/registry-index';
import { setupSuite } from '../lib/setup-suite';

// #145: impd builds each image by the digest it inspected. A registry the
// test owns proves it, on the host's loopback under a name, since the proxy
// refuses an IP or localhost; CI puts the name in /etc/hosts.
const prefix = setupSuite('registry');
const mutable = `${prefix}mutable`;
const multi = `${prefix}multi`;
const copied = `${prefix}copied`;
const REGISTRY_NAME = process.env['E2E_REGISTRY_NAME'] ?? 'imp-e2e-registry.test';
const CONTAINER = `${prefix}registry-${String(process.pid)}`;

// The engine asks a registry by name for HTTPS, so the test trusts its own
// certificate in /etc/docker/certs.d, which needs sudo; a name that
// resolves elsewhere would send the pushes there.
async function checkRegistryName(): Promise<boolean> {
  const resolved = await lookup(REGISTRY_NAME).catch(() => null);
  const sudo = await runCommand(['sudo', '--non-interactive', 'true']);

  if (resolved?.address !== '127.0.0.1' || sudo.exitCode !== 0) {
    // CI sets both up; a broken step must not pass as a skip
    if (process.env['CI'] !== undefined) {
      throw new Error(
        `CI is set, but ${REGISTRY_NAME} does not resolve to 127.0.0.1 or sudo needs a password`,
      );
    }

    console.log(
      `    skipped: the suite needs ${REGISTRY_NAME} to resolve to 127.0.0.1 and sudo with no password, as CI has; E2E_REGISTRY_NAME=imp-e2e.127.0.0.1.nip.io names one through DNS`,
    );

    return false;
  }

  return true;
}

const REGISTRY_READY = await checkRegistryName();

// under the repo: scripts/dev.sh mounts it at the same path in the container
const CACHE_DIR = join(REPO_ROOT, '.cache', 'e2e');

mkdirSync(CACHE_DIR, { recursive: true });

const buildDir = mkdtempSync(join(CACHE_DIR, 'registry-'));
const certs = join(buildDir, 'certs');

// the registry's host and port, once it runs
let registry = '';

// the engine's trust of the registry's certificate, once made
let trust: RegistryTrust | null = null;

beforeAll(async () => {
  if (!REGISTRY_READY) {
    return;
  }

  // the host engine's builds: a builder imp may not reach the host's
  // loopback, by design, so not this registry either; the suite goes with
  // IMP_BUILD_ISOLATION=host
  process.env['IMP_BUILD_ISOLATION'] = 'host';

  await runDevScript('reboot');

  // --bail skips afterAll: a failed run's registry goes here
  const stale = await runChecked([
    'docker',
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `name=^${prefix}registry-`,
  ]);

  for (const id of stale.split('\n').filter((line) => line !== '')) {
    await runCommand(['docker', 'rm', '--force', '--volumes', id]);
  }

  mkdirSync(certs);

  await runChecked([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    `/CN=${REGISTRY_NAME}`,
    '-addext',
    `subjectAltName=DNS:${REGISTRY_NAME}`,
    '-keyout',
    join(certs, 'key.pem'),
    '-out',
    join(certs, 'cert.pem'),
  ]);

  await runChecked([
    'docker',
    'run',
    '--detach',
    '--name',
    CONTAINER,
    '--publish',
    '127.0.0.1::5000',
    '--volume',
    `${certs}:/certs:ro`,
    '--env',
    'REGISTRY_HTTP_TLS_CERTIFICATE=/certs/cert.pem',
    '--env',
    'REGISTRY_HTTP_TLS_KEY=/certs/key.pem',
    'registry:2',
  ]);

  const published = await runChecked(['docker', 'port', CONTAINER, '5000/tcp']);

  const port = published.trim().split('\n')[0]?.split(':').at(-1) ?? '';

  registry = `${REGISTRY_NAME}:${port}`;

  // the engine reads it on each request: no restart
  trust = await createRegistryTrust({ registry, certPath: join(certs, 'cert.pem') });
}, 600_000);

afterAll(async () => {
  rmSync(buildDir, { recursive: true, force: true });

  await runCommand(['docker', 'rm', '--force', '--volumes', CONTAINER]);

  await trust?.remove();

  for (const name of [mutable, multi, copied]) {
    await tryImp(['image', 'rm', name]);
  }

  if (process.env['IMP_BUILD_ISOLATION'] === 'host') {
    delete process.env['IMP_BUILD_ISOLATION'];

    await runDevScript('reboot');
  }
}, 600_000);

// a context directory with this Dockerfile and a file v holding value
function writeContext(name: string, dockerfile: string, value: string): string {
  const dir = join(buildDir, name);

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Dockerfile'), dockerfile);
  writeFileSync(join(dir, 'v'), `${value}\n`);

  return dir;
}

// busybox by its index digest, so a build for another platform moves no tag
async function readBusyboxDigest(): Promise<string> {
  await runChecked(['docker', 'pull', '--quiet', 'busybox:1.37']);

  const digests = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    'busybox:1.37',
  ]);

  const own = z
    .array(z.string())
    .parse(JSON.parse(digests))
    .find((digest) => digest.startsWith('busybox@'));

  if (own === undefined) {
    throw new Error(`busybox:1.37 has no busybox RepoDigest: ${digests}`);
  }

  return own;
}

// builds the context as tag, for the engine's platform unless given one,
// and pushes it
async function buildPushedImage(dir: string, tag: string, platform?: string): Promise<void> {
  const platformArgs = platform === undefined ? [] : ['--platform', platform];

  await runChecked([
    'docker',
    'build',
    '--quiet',
    ...platformArgs,
    '--provenance=false',
    '--sbom=false',
    '--tag',
    tag,
    dir,
  ]);

  await runChecked(['docker', 'push', '--quiet', tag]);
}

async function readRepoDigests(tag: string): Promise<string[]> {
  const digests = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    tag,
  ]);

  return z.array(z.string()).parse(JSON.parse(digests));
}

// the manifest references the registry was asked for, in order
async function listManifestRequests(repository: string): Promise<string[]> {
  const logs = await runCommand(['docker', 'logs', CONTAINER]);

  const pattern = new RegExp(`uri="/v2/${repository}/manifests/(?<reference>[^"]+)"`, 'gv');

  return [...`${logs.stdout}${logs.stderr}`.matchAll(pattern)].map(
    (match) => match.groups?.['reference'] ?? '',
  );
}

async function readFileInImage(name: string, path: string): Promise<string> {
  const output = await runChecked(['docker', 'run', '--rm', `imp/${name}:latest`, 'cat', path]);

  return output.trim();
}

// the engine's architecture, as image configs name it
async function readHostArch(): Promise<string> {
  const arch = await runChecked(['docker', 'version', '--format', '{{.Server.Arch}}']);

  return arch.trim();
}

interface MovedTag {
  readonly tag: string;
  readonly kept: string;
  readonly pinned: string;
}

// A tag the host has on old content, which the registry moved to new: the
// pin must keep the build on the old.
async function setupMovedTag(repository: string): Promise<MovedTag> {
  const busybox = await readBusyboxDigest();

  const tag = `${registry}/${repository}:1`;
  const from = `FROM ${busybox}\nCOPY v /v\n`;

  await buildPushedImage(writeContext(`${repository}-old`, from, 'old'), tag);

  // the containerd store drops an image whose last tag moves
  const kept = `${registry}/${repository}:kept`;

  await runChecked(['docker', 'tag', tag, kept]);

  const repoDigests = await readRepoDigests(tag);

  const pinned = repoDigests.find((digest) => digest.startsWith(`${registry}/${repository}@`));

  if (pinned === undefined) {
    throw new Error(`${tag} has no RepoDigest under its repository: ${repoDigests.join(', ')}`);
  }

  await buildPushedImage(writeContext(`${repository}-new`, from, 'new'), tag);
  await runChecked(['docker', 'tag', kept, tag]);

  return { tag, kept, pinned };
}

// builds the context as name, and returns the manifest references the
// registry saw during the build
async function buildAndListRequests(
  repository: string,
  dockerfile: string,
  name: string,
): Promise<string[]> {
  const before = await listManifestRequests(repository);

  await runImp('image', 'build', writeContext(`build-${name}`, dockerfile, ''), '--name', name);

  const after = await listManifestRequests(repository);

  const seen = after.slice(before.length);

  console.log(
    `    the registry saw ${String(seen.length)} manifest requests during the build: ${seen.join(', ')}`,
  );

  return seen;
}

// the engine may use the host's copy and ask nothing, or ask for the pin;
// never for the tag
function checkRequests(moved: Readonly<MovedTag>, seen: readonly string[]): void {
  const digest = moved.pinned.slice(moved.pinned.indexOf('@') + 1);

  expect(seen.filter((reference) => reference !== digest)).toEqual([]);
}

test.skipIf(!REGISTRY_READY)(
  'a tag moved in the registry after the host pulled it builds the content impd inspected',
  async () => {
    const repository = 'e2e/mutable';

    const moved = await setupMovedTag(repository);

    try {
      const seen = await buildAndListRequests(
        repository,
        `FROM ${moved.tag}\nRUN cat /v\n`,
        mutable,
      );

      checkRequests(moved, seen);
    } finally {
      await runCommand(['docker', 'rmi', moved.tag, moved.kept]);
    }

    const content = await readFileInImage(mutable, '/v');

    expect(content).toBe('old');
  },
);

test.skipIf(!REGISTRY_READY)(
  'COPY --from and RUN --mount from= a moved tag use the content impd inspected',
  async () => {
    const busybox = await readBusyboxDigest();

    const repository = 'e2e/source';

    const moved = await setupMovedTag(repository);

    const dockerfile = [
      `FROM ${busybox}`,
      `COPY --from=${moved.tag} /v /copied`,
      `RUN --mount=from=${moved.tag},target=/m cp /m/v /mounted`,
      '',
    ].join('\n');

    try {
      const seen = await buildAndListRequests(repository, dockerfile, copied);

      checkRequests(moved, seen);
    } finally {
      await runCommand(['docker', 'rmi', moved.tag, moved.kept]);
    }

    const fromCopy = await readFileInImage(copied, '/copied');
    const fromMount = await readFileInImage(copied, '/mounted');

    expect([fromCopy, fromMount]).toEqual(['old', 'old']);
  },
);

test.skipIf(!REGISTRY_READY)(
  'a multi-platform image binds the host’s variant, whose ONBUILD-free config impd inspected',
  async () => {
    const busybox = await readBusyboxDigest();
    const hostArch = await readHostArch();

    const otherArch = hostArch === 'arm64' ? 'amd64' : 'arm64';
    const repository = 'e2e/multi';
    const index = `${registry}/${repository}:1`;
    const host = `${registry}/${repository}:${hostArch}`;
    const other = `${registry}/${repository}:${otherArch}`;

    await buildPushedImage(
      writeContext('host', `FROM ${busybox}\nCOPY v /v\n`, hostArch),
      host,
      `linux/${hostArch}`,
    );

    // a trigger impd would refuse, and that fails the build if it ran
    await buildPushedImage(
      writeContext('other', `FROM ${busybox}\nCOPY v /v\nONBUILD RUN false\n`, otherArch),
      other,
      `linux/${otherArch}`,
    );

    await writeRegistryIndex({
      registry,
      ca: readFileSync(join(certs, 'cert.pem'), 'utf8'),
      repository,
      tag: '1',
      entries: [
        { tag: hostArch, architecture: hostArch },
        { tag: otherArch, architecture: otherArch },
      ],
    });

    await runChecked(['docker', 'rmi', host, other]);

    try {
      await runImp(
        'image',
        'build',
        writeContext('build-multi', `FROM ${index}\nRUN cat /v\n`, ''),
        '--name',
        multi,
      );
    } finally {
      await runCommand(['docker', 'rmi', index]);
    }

    const content = await readFileInImage(multi, '/v');

    expect(content).toBe(hostArch);

    const references = await listManifestRequests(repository);

    console.log(`    the registry saw manifest requests: ${references.join(', ')}`);
  },
);
