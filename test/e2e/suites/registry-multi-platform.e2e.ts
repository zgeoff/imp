import { expect, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../lib/config';
import { createRegistryTrust } from '../lib/create-registry-trust';
import { createInstanceClient, runImp } from '../lib/imp-cli';
import { REPO_ROOT, runChecked, runCommand } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import { writeRegistryIndex } from '../lib/registry-index';
import {
  buildPushedImage,
  checkRegistryReady,
  listManifestRequests,
  readBusyboxDigest,
  readFileInImage,
  readHostArch,
  removeStaleRegistries,
  startRegistry,
  writeContext,
} from '../lib/registry-steps';
import { removeImageIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// A multi-platform index in a registry the journey owns
// (lib/registry-steps.ts), on the suite's IMP_BUILD_ISOLATION=host: impd
// binds the host's variant and inspects that variant's config.
const REGISTRY_NAME = process.env['E2E_REGISTRY_NAME'] ?? 'imp-e2e-registry.test';

const isReady = await checkRegistryReady(REGISTRY_NAME);

// one stack for every release: the trust goes before its registry
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const prefix = readSuitePrefix('registry');

  // under the repo: scripts/dev.sh mounts it at the same path in the container
  const dir = await mkdtemp(join(REPO_ROOT, '.cache', 'e2e', 'registry-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  await removeStaleRegistries(prefix);

  const container = `${prefix}registry-${String(process.pid)}`;

  const registry = await startRegistry(stack, REGISTRY_NAME, container, dir);

  // the engine reads certs.d on each request: no restart
  const trust = await createRegistryTrust({
    registry: registry.address,
    certPath: registry.certPath,
  });

  stack.defer(() => trust.remove());

  return { prefix, stack, dir, registry, client: await createInstanceClient() };
}

test.skipIf(!isReady)(
  'it binds the host’s variant of a multi-platform image, whose ONBUILD-free config impd inspected',
  async () => {
    const ctx = await setupTest();

    const multi = `${ctx.prefix}multi`;

    const busybox = await readBusyboxDigest();
    const hostArch = await readHostArch();

    const otherArch = hostArch === 'arm64' ? 'amd64' : 'arm64';
    const repository = 'e2e/multi';
    const index = `${ctx.registry.address}/${repository}:1`;
    const host = `${ctx.registry.address}/${repository}:${hostArch}`;
    const other = `${ctx.registry.address}/${repository}:${otherArch}`;

    await buildPushedImage(
      writeContext(ctx.dir, 'host', `FROM ${busybox}\nCOPY v /v\n`, hostArch),
      host,
      `linux/${hostArch}`,
    );

    // gone already once the explicit rmi below ran
    ctx.stack.defer(async () => {
      await runCommand(['docker', 'rmi', host]);
    });

    // a trigger impd would refuse, and that fails the build if it ran
    await buildPushedImage(
      writeContext(ctx.dir, 'other', `FROM ${busybox}\nCOPY v /v\nONBUILD RUN false\n`, otherArch),
      other,
      `linux/${otherArch}`,
    );

    ctx.stack.defer(async () => {
      await runCommand(['docker', 'rmi', other]);
    });

    await writeRegistryIndex({
      registry: ctx.registry.address,
      ca: readFileSync(ctx.registry.certPath, 'utf8'),
      repository,
      tag: '1',
      entries: [
        { tag: hostArch, architecture: hostArch },
        { tag: otherArch, architecture: otherArch },
      ],
    });

    await runChecked(['docker', 'rmi', host, other]);

    ctx.stack.defer(async () => {
      await runCommand(['docker', 'rmi', index]);
    });

    registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, multi));

    await runImp(
      'image',
      'build',
      writeContext(ctx.dir, 'build-multi', `FROM ${index}\nRUN cat /v\n`, ''),
      '--name',
      multi,
    );

    const content = await readFileInImage(multi, '/v');
    const references = await listManifestRequests(ctx.registry, repository);

    console.log(`    the registry saw manifest requests: ${references.join(', ')}`);

    expect(content).toBe(hostArch);
  },
);
