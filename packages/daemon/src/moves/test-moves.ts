import { writeFileSync } from 'node:fs';
import type { MoveStatus } from '@imp/api';
import { buildTestApp, setupImpTest } from '../imps/test-imps';
import type { ImpTest, ImpTestOptions } from '../imps/test-imps';
import { deriveSlotAddress } from '../net/addressing';
import { buildImagePaths } from '../storage/data-layout';
import { readWarmHost } from './warm-facts';

// the target's peer URL: a literal tailnet address, as a move needs
export const TARGET_URL = 'http://100.100.0.2:7070';

// the source's address, as the target's socket sees it
export const SOURCE_PEER = '100.100.0.1';

export type FetchHook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

interface MoveHostsOptions {
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

// Two impds in one process: `source` sends to `target` through `fetch`,
// which hands each request to the target's move routes as from the tailnet.
export async function setupMoveHosts(options: MoveHostsOptions = {}) {
  const source = await setupImpTest(options.source);

  const target = await setupImpTest({
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

  const targetApp = buildTestApp(target, target, undefined, {}, null, shared);
  const sendToTarget = (request: Request) => targetApp.moves.handle(request, SOURCE_PEER);
  const hook = options.hook;

  const sourceApp = buildTestApp(source, sourceImpd, undefined, {}, null, {
    ...shared,
    readTapMac:
      options.readTapMac ??
      ((tap) => deriveSlotAddress(Number(tap.slice('imp'.length)), slotPlan).hostMac),
    fetch: (request) =>
      hook === undefined ? sendToTarget(request) : hook(request, () => sendToTarget(request)),
    ...(options.partBytes !== undefined && { partBytes: options.partBytes }),
  });

  const waitForMove = async (name: string): Promise<MoveStatus> => {
    const deadline = Date.now() + (options.moveTimeoutMs ?? 5000);

    while (Date.now() < deadline) {
      const status = await sourceApp.client.moves.status({ name });

      if (status.isDone || status.error !== null) {
        return status;
      }

      await Bun.sleep(10);
    }

    throw new Error(`the move of ${name} never ended`);
  };

  // a whole move, as `imp move` runs it (packages/cli/src/commands/move.ts):
  // ZFS streams to a ZFS target, and the memory too when the facts match
  const runMove = async (name: string, stop = false): Promise<MoveStatus> => {
    const info = await targetApp.client.system.info();
    const targetFacts = await targetApp.client.moves.facts();

    const plan = await sourceApp.client.moves.prepare({
      name,
      stop,
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
    runMove,
    waitForMove,
    async [Symbol.asyncDispose]() {
      await source[Symbol.asyncDispose]();
      await target[Symbol.asyncDispose]();
    },
  };
}

// the `ubuntu` test image, with the config.json a create reads
export async function createUbuntuImage(
  host: Readonly<Pick<ImpTest, 'createTestImage' | 'dataDir'>>,
): Promise<void> {
  await host.createTestImage('ubuntu');

  writeFileSync(buildImagePaths(host.dataDir, 'sha256:ubuntu').config, '{}');
}
