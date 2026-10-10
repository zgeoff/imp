import { expect, onTestFinished, test } from 'bun:test';
import { X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@imp/test-utils/update-env';
import { createStubBin } from '../../../scripts/test-utils/create-stub-bin';
import { instance } from './instance';
import {
  createMovedTag,
  findRepoDigest,
  findUnpinnedRequests,
  parseManifestRequests,
  parsePublishedPort,
  removeStaleRegistries,
  startRegistry,
} from './registry-steps';

// the caller's stack goes before the temp dir that holds the stub docker
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'registry-steps-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { stack, dir };
}

test('#parsePublishedPort reads the first published host port', () => {
  expect(parsePublishedPort('127.0.0.1:49153\n[::1]:49154\n')).toBe('49153');
});

test('#parsePublishedPort fails on output with no port', () => {
  expect(() => parsePublishedPort('')).toThrowWithMessage(Error, 'no published port in ""');
});

test('#parseManifestRequests reads the repository’s manifest references in order', () => {
  const logs = [
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/manifests/1"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/other/manifests/1"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/manifests/sha256:abc"',
    'level=info msg="response completed" http.request.uri="/v2/e2e/mutable/blobs/sha256:def"',
  ].join('\n');

  expect(parseManifestRequests(logs, 'e2e/mutable')).toStrictEqual(['1', 'sha256:abc']);
});

test('#findRepoDigest picks the digest under the repository', () => {
  const digests = JSON.stringify(['mirror.test/busybox@sha256:aaa', 'busybox@sha256:bbb']);

  expect(findRepoDigest(digests, 'busybox')).toBe('busybox@sha256:bbb');
});

test('#findRepoDigest fails when no digest is under the repository', () => {
  expect(() => findRepoDigest('["mirror.test/busybox@sha256:aaa"]', 'busybox')).toThrowWithMessage(
    Error,
    'no RepoDigest under busybox in ["mirror.test/busybox@sha256:aaa"]',
  );
});

test('#findUnpinnedRequests keeps every reference but the pin’s digest', () => {
  expect(
    findUnpinnedRequests('reg.test:5000/e2e/mutable@sha256:abc', ['sha256:abc', '1', 'sha256:abc']),
  ).toStrictEqual(['1']);
});

test('#startRegistry runs a registry labelled with the instance, on a certificate for its name', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    ['case "$1" in', '  container) exit 1 ;;', '  port) echo 127.0.0.1:49153 ;;', 'esac'].join(
      '\n',
    ),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const registry = await startRegistry(
    ctx.stack,
    'imp-e2e-registry.test',
    'e2e-reg-registry-1',
    ctx.dir,
  );

  const calls = await readFile(docker.calls, 'utf8');
  const pem = await readFile(join(ctx.dir, 'certs', 'cert.pem'));

  const cert = new X509Certificate(pem);

  expect(registry).toStrictEqual({
    address: 'imp-e2e-registry.test:49153',
    container: 'e2e-reg-registry-1',
    certPath: join(ctx.dir, 'certs', 'cert.pem'),
  });

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect e2e-reg-registry-1',
    `docker run --detach --name e2e-reg-registry-1 --label imp-e2e-instance=${instance.container} --publish 127.0.0.1::5000 --volume ${join(ctx.dir, 'certs')}:/certs:ro --env REGISTRY_HTTP_TLS_CERTIFICATE=/certs/cert.pem --env REGISTRY_HTTP_TLS_KEY=/certs/key.pem registry:2`,
    'docker port e2e-reg-registry-1 5000/tcp',
    '',
  ]);

  expect(cert.subjectAltName).toBe('DNS:imp-e2e-registry.test');
});

test('#startRegistry removes the registry it ran once the stack goes', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    ['case "$1" in', '  container) exit 1 ;;', '  port) echo 127.0.0.1:49153 ;;', 'esac'].join(
      '\n',
    ),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  await startRegistry(ctx.stack, 'imp-e2e-registry.test', 'e2e-reg-registry-1', ctx.dir);

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n').at(-2)).toBe('docker rm --force --volumes e2e-reg-registry-1');
});

test('#startRegistry refuses a container name that is taken, before it makes anything', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(ctx.dir, 'docker', 'exit 0');

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  expect(
    startRegistry(ctx.stack, 'imp-e2e-registry.test', 'e2e-reg-registry-1', ctx.dir),
  ).rejects.toThrowWithMessage(Error, 'a container named e2e-reg-registry-1 is already there');

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls).toBe('docker container inspect e2e-reg-registry-1\n');
  expect(existsSync(join(ctx.dir, 'certs'))).toBeFalse();
});

test('#startRegistry removes nothing when the registry does not start', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    ['case "$1" in', '  container|run) exit 1 ;;', 'esac'].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  expect(
    startRegistry(ctx.stack, 'imp-e2e-registry.test', 'e2e-reg-registry-1', ctx.dir),
  ).rejects.toThrow();

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n')).toSatisfyAll((line: string) => !line.startsWith('docker rm '));
});

test('#removeStaleRegistries never removes a registry container this instance did not label', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    [
      'case "$*" in',
      '  *label=*) echo e2e-reg-registry-1 ;;',
      String.raw`  ps*) printf 'e2e-reg-registry-1\ne2e-reg-registry-2\n' ;;`,
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const swept = await removeStaleRegistries('e2e-reg-');
  const calls = await readFile(docker.calls, 'utf8');

  expect(swept).toStrictEqual({ removed: ['e2e-reg-registry-1'], left: ['e2e-reg-registry-2'] });

  expect(calls.split('\n')).toStrictEqual([
    'docker ps --all --format {{.Names}} --filter name=^e2e-reg-registry-',
    `docker ps --all --format {{.Names}} --filter name=^e2e-reg-registry- --filter label=imp-e2e-instance=${instance.container}`,
    'docker rm --force --volumes e2e-reg-registry-1',
    '',
  ]);
});

test('#createMovedTag moves the tag to new content and pins the old, and removes both tags with the stack', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    [
      'case "$*" in',
      `  'image inspect --format {{json .RepoDigests}} busybox:1.37') echo '["busybox@sha256:aaa"]' ;;`,
      `  'image inspect'*) echo '["imp-e2e-registry.test:49153/e2e/mutable@sha256:bbb"]' ;;`,
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const registry = {
    address: 'imp-e2e-registry.test:49153',
    container: 'e2e-reg-registry-1',
    certPath: join(ctx.dir, 'cert.pem'),
  };

  const moved = await createMovedTag(ctx.stack, registry, ctx.dir, 'e2e/mutable');

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  const tag = 'imp-e2e-registry.test:49153/e2e/mutable:1';
  const kept = 'imp-e2e-registry.test:49153/e2e/mutable:kept';

  expect(moved).toStrictEqual({
    tag,
    kept,
    pinned: 'imp-e2e-registry.test:49153/e2e/mutable@sha256:bbb',
  });

  expect(calls.split('\n')).toStrictEqual([
    'docker pull --quiet busybox:1.37',
    'docker image inspect --format {{json .RepoDigests}} busybox:1.37',
    `docker build --quiet --provenance=false --sbom=false --tag ${tag} ${join(ctx.dir, 'e2e', 'mutable-old')}`,
    `docker push --quiet ${tag}`,
    `docker tag ${tag} ${kept}`,
    `docker image inspect --format {{json .RepoDigests}} ${tag}`,
    `docker build --quiet --provenance=false --sbom=false --tag ${tag} ${join(ctx.dir, 'e2e', 'mutable-new')}`,
    `docker push --quiet ${tag}`,
    `docker tag ${kept} ${tag}`,
    `docker rmi ${kept}`,
    `docker rmi ${tag}`,
    '',
  ]);
});

test('#createMovedTag removes the tag it made when a later step fails', async () => {
  const ctx = await setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    [
      'case "$*" in',
      `  'image inspect'*) echo '["busybox@sha256:aaa"]' ;;`,
      '  tag*) exit 1 ;;',
      'esac',
    ].join('\n'),
  );

  updateEnv('PATH', `${docker.bin}:${process.env['PATH'] ?? ''}`);

  const registry = {
    address: 'imp-e2e-registry.test:49153',
    container: 'e2e-reg-registry-1',
    certPath: join(ctx.dir, 'cert.pem'),
  };

  expect(createMovedTag(ctx.stack, registry, ctx.dir, 'e2e/mutable')).rejects.toThrow();

  await ctx.stack.disposeAsync();

  const calls = await readFile(docker.calls, 'utf8');

  expect(calls.split('\n').filter((line) => line.startsWith('docker rmi '))).toStrictEqual([
    'docker rmi imp-e2e-registry.test:49153/e2e/mutable:1',
  ]);
});
