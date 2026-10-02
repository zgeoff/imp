import { listImps } from '../db/imps';
import type { ImpContext } from './imp-context';
import type { ResourceDelta } from './resource-sampler';

// One pass of the sampler over every running VM; an imp that is not running
// any more leaves the cache. Returns what each used since the last pass.
export async function readRunningImpUsage(context: ImpContext): Promise<ResourceDelta[]> {
  const imps = await listImps(context.db);

  const deltas: ResourceDelta[] = [];

  const running = new Set<string>();

  for (const imp of imps) {
    if (imp.state !== 'running' || imp.pid === null) {
      continue;
    }

    running.add(imp.id);

    const delta = context.resources.readVmUsage({
      impId: imp.id,
      pid: imp.pid,
      apiSocket: context.findPaths(imp.id).apiSocket,
      tap: context.findAddress(imp.slot).tap,
    });

    if (delta !== null) {
      deltas.push(delta);
    }
  }

  context.resources.keepOnly(running);

  return deltas;
}

// counts the imp's usage from now: at a spawn and at an adopt
export function startCounting(
  context: ImpContext,
  imp: Readonly<{ id: string; slot: number }>,
  pid: number,
): void {
  context.resources.startCounting({
    impId: imp.id,
    pid,
    apiSocket: context.findPaths(imp.id).apiSocket,
    tap: context.findAddress(imp.slot).tap,
  });
}
