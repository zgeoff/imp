import { impContract } from '@imp/api';
import type { SystemInfo } from '@imp/api';
import { ORPCError, implement } from '@orpc/server';
import packageJson from '../package.json' with { type: 'json' };
import type { Config } from './config';
import { countImps } from './db/imps';
import type { ImpDatabase } from './db/open-database';

export interface RouterDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
}

export function buildRouter(deps: RouterDeps) {
  const os = implement(impContract);

  return os.router({
    imps: {
      create: os.imps.create.handler(handleUnimplemented),
      list: os.imps.list.handler(handleUnimplemented),
      get: os.imps.get.handler(handleUnimplemented),
      destroy: os.imps.destroy.handler(handleUnimplemented),
      sleep: os.imps.sleep.handler(handleUnimplemented),
      wake: os.imps.wake.handler(handleUnimplemented),
      hold: os.imps.hold.handler(handleUnimplemented),
      url: os.imps.url.handler(handleUnimplemented),
      fork: os.imps.fork.handler(handleUnimplemented),
    },
    checkpoints: {
      create: os.checkpoints.create.handler(handleUnimplemented),
      list: os.checkpoints.list.handler(handleUnimplemented),
      restore: os.checkpoints.restore.handler(handleUnimplemented),
      delete: os.checkpoints.delete.handler(handleUnimplemented),
    },
    images: {
      list: os.images.list.handler(handleUnimplemented),
      add: os.images.add.handler(handleUnimplemented),
      build: os.images.build.handler(handleUnimplemented),
      delete: os.images.delete.handler(handleUnimplemented),
    },
    system: {
      info: os.system.info.handler(() => readSystemInfo(deps)),
    },
  });
}

// Runtime stats (RAM in use, Firecracker and Tailscale state) read as zero
// and null until the governor and the vmm exist.
async function readSystemInfo(deps: RouterDeps): Promise<SystemInfo> {
  return {
    version: packageJson.version,
    ramBudgetMib: deps.config.ramBudgetMib,
    ramUsedMib: 0,
    awakeCount: await countImps(deps.db, 'running'),
    impCount: await countImps(deps.db),
    firecrackerVersion: null,
    tailscale: {
      enabled: deps.config.tailscaleAuthKey !== null,
      state: null,
      hostname: null,
    },
  };
}

function handleUnimplemented(): never {
  throw new ORPCError('NOT_IMPLEMENTED', { message: 'not implemented yet' });
}
