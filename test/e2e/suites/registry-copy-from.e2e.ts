import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../lib/config';
import { createRegistryTrust } from '../lib/create-registry-trust';
import { createInstanceClient } from '../lib/imp-cli';
import { REPO_ROOT } from '../lib/instance';
import { registerRemoval } from '../lib/register-removal';
import {
  buildAndListRequests,
  checkRegistryReady,
  createMovedTag,
  findUnpinnedRequests,
  readBusyboxDigest,
  readFileInImage,
  removeStaleRegistries,
  startRegistry,
} from '../lib/registry-steps';
import { removeImageIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';

// #145 for the other stages a Dockerfile names: COPY --from and RUN --mount
// from= a tag the registry moved, against a registry the journey owns
// (lib/registry-steps.ts), on the suite's IMP_BUILD_ISOLATION=host.
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
  'it uses the content impd inspected for COPY --from and RUN --mount from= a moved tag',
  async () => {
    const ctx = await setupTest();

    const copied = `${ctx.prefix}copied`;
    const repository = 'e2e/source';

    const busybox = await readBusyboxDigest();
    const moved = await createMovedTag(ctx.stack, ctx.registry, ctx.dir, repository);

    const dockerfile = [
      `FROM ${busybox}`,
      `COPY --from=${moved.tag} /v /copied`,
      `RUN --mount=from=${moved.tag},target=/m cp /m/v /mounted`,
      '',
    ].join('\n');

    registerRemoval(ctx.stack, config.keep, () => removeImageIfPresent(ctx.client, copied));

    const seen = await buildAndListRequests(ctx.registry, ctx.dir, repository, dockerfile, copied);
    const fromCopy = await readFileInImage(copied, '/copied');
    const fromMount = await readFileInImage(copied, '/mounted');

    expect(findUnpinnedRequests(moved.pinned, seen)).toStrictEqual([]);
    expect(fromCopy).toBe('old');
    expect(fromMount).toBe('old');
  },
);
