import { onTestFinished } from 'bun:test';
import { writeFileSync } from 'node:fs';
import type { MoveStatus } from '@imp/api';
import { invariant } from '@imp/test-utils/invariant';
import { waitFor } from '@imp/test-utils/wait-for';
import { createImage } from '../db/images';
import { buildTestApp, createImpTest } from '../imps/test-imps';
import type { ImpTest, ImpTestOptions } from '../imps/test-imps';
import { deriveSlotAddress } from '../net/addressing';
import { buildImagePaths } from '../storage/data-layout';
import { readWarmHost } from './warm-facts';

// the target's peer URL: a literal tailnet address, as a move needs
export const TARGET_URL = 'http://100.100.0.2:7070';

// the source's address, as the target's socket sees it
export const SOURCE_PEER = '100.100.0.1';

// what a hook may reach when a request goes: the target's clock and the
// source's client
interface MoveHookHosts {
  readonly target: Readonly<Pick<HostTest, 'advance'>>;
  readonly sourceApp: Readonly<Pick<TestApp, 'client'>>;
}

// `forward` sends the request to the target's move routes, or the one it is
// given in its place
export type FetchHook = (
  request: Request,
  forward: (replacement?: Request) => Promise<Response>,
  hosts: Readonly<MoveHookHosts>,
) => Promise<Response>;

type HostTest = Awaited<ReturnType<typeof createImpTest>>;

type TestApp = ReturnType<typeof buildTestApp>;

export interface MoveHostsOptions {
  // sees each request the source sends to the target's move routes
  readonly hook?: FetchHook;
  readonly partBytes?: number;

  // the source's taps' MACs; each slot's own by default
  readonly readTapMac?: (tap: string) => string | null;

  // Both hosts report the target's warm facts, and the source's VMs open
  // the target's system drive path. Two impds in one process cannot share
  // a data dir, as a warm move needs.
  readonly isShared?: boolean;
  readonly source?: ImpTestOptions;
  readonly target?: ImpTestOptions;

  // how long a move may take; a real pool takes seconds
  readonly moveTimeoutMs?: number;
}

// Two impds in one process: `source` sends to `target` through `fetch`, as
// from the tailnet. One stack releases both at the test's end, the target
// first; a throw in one release does not skip the other.
export function setupMoveHosts(options: MoveHostsOptions = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return createMoveHosts(stack, options);
}

// setupMoveHosts' hosts, their releases in `stack`, for a test whose own
// resources must outlive both impds
export async function createMoveHosts(
  stack: Readonly<AsyncDisposableStack>,
  options: MoveHostsOptions = {},
) {
  const source = await createImpTest(stack, options.source);

  const target = await createImpTest(stack, {
    ...options.target,
    env: { IMP_PEER_URL: TARGET_URL, ...options.target?.env },
  });

  const facts = readWarmHost(target.config, target.readIdentity(), target.storage.kind);
  const shared = options.isShared === true ? { readWarmHost: () => facts } : {};
  const slotPlan = { subnet: source.config.subnet, portBase: 0 };

  const sourceImpd =
    options.isShared === true
      ? source.restartImpd({
          ...source.readIdentity(),
          systemDrivePath: target.readIdentity().systemDrivePath,
        })
      : source;

  // the names the target's commits handed to onCommitted, in order
  const commits: string[] = [];

  const targetApp = buildTestApp(target, target, undefined, {}, null, {
    ...shared,
    onCommitted: (name) => {
      commits.push(name);
    },
  });

  const sendToTarget = (request: Request) => targetApp.moves.handle(request, SOURCE_PEER);
  const hook = options.hook;

  // the source's app, once built, for the hook to see; no request goes before
  const built: { hosts: MoveHookHosts | null } = { hosts: null };

  const runHook = (request: Request, call: FetchHook): Promise<Response> => {
    invariant(built.hosts);

    return call(request, (replacement) => sendToTarget(replacement ?? request), built.hosts);
  };

  const sourceApp = buildTestApp(source, sourceImpd, undefined, {}, null, {
    ...shared,
    readTapMac:
      options.readTapMac ??
      ((tap) => deriveSlotAddress(Number(tap.slice('imp'.length)), slotPlan).hostMac),
    fetch: (request) => (hook === undefined ? sendToTarget(request) : runHook(request, hook)),
    ...(options.partBytes !== undefined && { partBytes: options.partBytes }),
  });

  built.hosts = { target, sourceApp };

  const waitForMove = (name: string): Promise<MoveStatus> =>
    waitFor(
      async () => {
        const status = await sourceApp.client.moves.status({ name });

        if (!status.isDone && status.error === null) {
          throw new Error(`the move of ${name} never ended`);
        }

        return status;
      },
      { timeoutMs: options.moveTimeoutMs ?? 5000 },
    );

  // a whole move, as `imp move` runs it (packages/cli/src/commands/move.ts):
  // ZFS streams to a ZFS target, and the memory too when the facts match;
  // a stop forces, as --stop does
  const runMove = async (name: string, stop = false): Promise<MoveStatus> => {
    const info = await targetApp.client.system.info();
    const targetFacts = await targetApp.client.moves.facts();

    const plan = await sourceApp.client.moves.prepare({
      name,
      stop,
      ...(stop && { force: true }),
      targetStorage: info.storage.backend,
      target: targetFacts,
    });

    const ticket = await targetApp.client.moves.receive({
      name,
      bytes: plan.bytes,
      ...(plan.warm !== null && { warm: plan.warm }),
    });

    await sourceApp.client.moves.send({ name, to: ticket.peerUrl, ticket: ticket.ticket });

    return waitForMove(name);
  };

  return {
    source,
    target,
    sourceApp,
    targetApp,
    commits,
    runMove,
    waitForMove,
  };
}

// the `ubuntu` test image, with the config.json a create reads
export async function createUbuntuImage(
  host: Readonly<Pick<ImpTest, 'createTestImage' | 'dataDir'>>,
): Promise<void> {
  await host.createTestImage('ubuntu');

  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');
}

// the `ubuntu` image on a host whose storage is buildStubZfsStorage's: the
// storage starts, then the image is a dataset with the files a create reads
export async function createZfsUbuntuImage(
  host: Readonly<Pick<ImpTest, 'db' | 'dataDir' | 'storage'>>,
): Promise<void> {
  await host.storage.start({
    impIds: new Set(),
    checkpointIds: new Set(),
    imageDigests: new Set(),
  });

  await host.storage.createImage('sha256:ubuntu', () => Promise.resolve());

  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').rootfs, 'rootfs');
  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');

  await createImage(host.db, {
    name: 'ubuntu',
    ref: 'ubuntu:latest',
    digest: 'sha256:ubuntu',
    sizeBytes: 6,
  });
}
