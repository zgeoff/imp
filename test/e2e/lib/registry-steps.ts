import { lookup } from 'node:dns/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { runImp } from './imp-cli';
import { runChecked, runCommand } from './instance';

// A registry a registry journey owns, on the host's loopback under a name,
// since the proxy refuses an IP or localhost; CI puts the name in /etc/hosts.

export interface Registry {
  // host:port, as an image reference names it
  readonly address: string;
  readonly container: string;

  // its certificate, PEM, which the engine trusts in certs.d
  readonly certPath: string;
}

export interface MovedTag {
  readonly tag: string;
  readonly kept: string;
  readonly pinned: string;
}

const RepoDigestsSchema = z.array(z.string());

// the host port `docker port <container> 5000/tcp` printed first
export function parsePublishedPort(published: string): string {
  const port = published.trim().split('\n')[0]?.split(':').at(-1) ?? '';

  if (!/^\d+$/v.test(port)) {
    throw new Error(`no published port in "${published}"`);
  }

  return port;
}

// the manifest references the registry's log shows were asked for, in order
export function parseManifestRequests(logs: string, repository: string): string[] {
  const pattern = new RegExp(`uri="/v2/${repository}/manifests/(?<reference>[^"]+)"`, 'gv');

  return [...logs.matchAll(pattern)].map((match) => match.groups?.['reference'] ?? '');
}

// the one of an image's RepoDigests (JSON) under the repository
export function findRepoDigest(digests: string, repository: string): string {
  const own = RepoDigestsSchema.parse(JSON.parse(digests)).find((digest) =>
    digest.startsWith(`${repository}@`),
  );

  if (own === undefined) {
    throw new Error(`no RepoDigest under ${repository} in ${digests}`);
  }

  return own;
}

// what a build asked for besides the pin: the engine may use the host's copy
// and ask nothing, or ask for the pin, never for the tag
export function findUnpinnedRequests(pinned: string, seen: readonly string[]): string[] {
  const digest = pinned.slice(pinned.indexOf('@') + 1);

  return seen.filter((reference) => reference !== digest);
}

// The engine asks a registry by name for HTTPS, so a journey trusts its own
// certificate in certs.d, which needs sudo; a name that resolves elsewhere
// would send the pushes there. In CI a missing step throws, never skips.
export async function checkRegistryReady(name: string): Promise<boolean> {
  const resolved = await lookup(name).catch(() => null);
  const sudo = await runCommand(['sudo', '--non-interactive', 'true']);

  if (resolved?.address === '127.0.0.1' && sudo.exitCode === 0) {
    return true;
  }

  if (process.env['CI'] !== undefined) {
    throw new Error(
      `CI is set, but ${name} does not resolve to 127.0.0.1 or sudo needs a password`,
    );
  }

  console.log(
    `    skipped: the suite needs ${name} to resolve to 127.0.0.1 and sudo with no password, as CI has; E2E_REGISTRY_NAME=imp-e2e.127.0.0.1.nip.io names one through DNS`,
  );

  return false;
}

// Starts registry:2 with a certificate of its own under dir, as `container`;
// the caller removes the container.
export async function startRegistry(
  name: string,
  container: string,
  dir: string,
): Promise<Registry> {
  const certs = join(dir, 'certs');

  mkdirSync(certs, { recursive: true });

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
    `/CN=${name}`,
    '-addext',
    `subjectAltName=DNS:${name}`,
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
    container,
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

  const published = await runChecked(['docker', 'port', container, '5000/tcp']);

  return {
    address: `${name}:${parsePublishedPort(published)}`,
    container,
    certPath: join(certs, 'cert.pem'),
  };
}

// a registry a killed journey left: its stack never ran
export async function removeStaleRegistries(prefix: string): Promise<void> {
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
}

// a context directory with this Dockerfile and a file v holding value
export function writeContext(dir: string, name: string, dockerfile: string, value: string): string {
  const context = join(dir, name);

  mkdirSync(context, { recursive: true });
  writeFileSync(join(context, 'Dockerfile'), dockerfile);
  writeFileSync(join(context, 'v'), `${value}\n`);

  return context;
}

// busybox by its index digest, so a build for another platform moves no tag
export async function readBusyboxDigest(): Promise<string> {
  await runChecked(['docker', 'pull', '--quiet', 'busybox:1.37']);

  const digests = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    'busybox:1.37',
  ]);

  return findRepoDigest(digests, 'busybox');
}

// builds the context as tag, for the engine's platform unless given one, and
// pushes it
export async function buildPushedImage(
  context: string,
  tag: string,
  platform?: string,
): Promise<void> {
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
    context,
  ]);

  await runChecked(['docker', 'push', '--quiet', tag]);
}

export async function listManifestRequests(
  registry: Readonly<Registry>,
  repository: string,
): Promise<string[]> {
  const logs = await runCommand(['docker', 'logs', registry.container]);

  return parseManifestRequests(`${logs.stdout}${logs.stderr}`, repository);
}

export async function readFileInImage(name: string, path: string): Promise<string> {
  const output = await runChecked(['docker', 'run', '--rm', `imp/${name}:latest`, 'cat', path]);

  return output.trim();
}

// the engine's architecture, as image configs name it
export async function readHostArch(): Promise<string> {
  const arch = await runChecked(['docker', 'version', '--format', '{{.Server.Arch}}']);

  return arch.trim();
}

// A tag the host has on old content, which the registry moved to new: the
// pin must keep the build on the old. The caller removes tag and kept.
export async function createMovedTag(
  registry: Readonly<Registry>,
  dir: string,
  repository: string,
): Promise<MovedTag> {
  const busybox = await readBusyboxDigest();

  const tag = `${registry.address}/${repository}:1`;
  const from = `FROM ${busybox}\nCOPY v /v\n`;

  await buildPushedImage(writeContext(dir, `${repository}-old`, from, 'old'), tag);

  // the containerd store drops an image whose last tag moves
  const kept = `${registry.address}/${repository}:kept`;

  await runChecked(['docker', 'tag', tag, kept]);

  const repoDigests = await runChecked([
    'docker',
    'image',
    'inspect',
    '--format',
    '{{json .RepoDigests}}',
    tag,
  ]);

  const pinned = findRepoDigest(repoDigests, `${registry.address}/${repository}`);

  await buildPushedImage(writeContext(dir, `${repository}-new`, from, 'new'), tag);
  await runChecked(['docker', 'tag', kept, tag]);

  return { tag, kept, pinned };
}

// builds the context as name, and returns the manifest references the
// registry saw during the build
export async function buildAndListRequests(
  registry: Readonly<Registry>,
  dir: string,
  repository: string,
  dockerfile: string,
  name: string,
): Promise<string[]> {
  const before = await listManifestRequests(registry, repository);

  await runImp(
    'image',
    'build',
    writeContext(dir, `build-${name}`, dockerfile, ''),
    '--name',
    name,
  );

  const after = await listManifestRequests(registry, repository);

  const seen = after.slice(before.length);

  console.log(
    `    the registry saw ${String(seen.length)} manifest requests during the build: ${seen.join(', ')}`,
  );

  return seen;
}
