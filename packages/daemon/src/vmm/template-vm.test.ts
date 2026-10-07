import { expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { readErrorMessage } from '../read-error-message';
import { readRejection } from '../read-rejection';
import { buildImpPaths } from '../storage/data-layout';
import { startStubAgent } from '../test-utils/start-stub-agent';
import type { Jails } from './jail';
import { buildTemplateVm, loadTemplateVm } from './template-vm';
import type { TemplateBuildPlan, TemplateRestorePlan } from './template-vm';

// A Firecracker stand-in: an API on the socket its argv names, which logs
// each call to `log` and answers 204, or `status` to every PUT when given.
const STAND_IN = `
const [apiSocket, log, status] = process.argv.slice(-3);
const { appendFileSync } = require('node:fs');
Bun.serve({
  unix: apiSocket,
  fetch: (request) => {
    const path = new URL(request.url).pathname;
    appendFileSync(log, request.method + ' ' + path + '\\n');
    if (path === '/version') {
      return Response.json({ firecracker_version: 'v1.17.0' });
    }
    const failed = request.method === 'PUT' && status !== 'ok';
    return failed ? new Response('{"fault_message":"no"}', { status: 400 }) : new Response(null, { status: 204 });
  },
});
`;

const JAIL = { uid: 900_001, gid: 900_001 };

// a build chowns its snapshot files to its uid: the test's own, without root
const OWN_USER = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };

// a temp dir with the stand-in, its call log, and Jails that log what they
// are asked; `prepare` and `prepareBuild` start the stand-in
function setupTemplateTest(apiSocket: (dir: string) => string, status: 'ok' | 'fail' = 'ok') {
  const dir = mkdtempSync(join(tmpdir(), 'imp-tpl-vm-'));
  const log = join(dir, 'calls.log');
  const script = join(dir, 'firecracker.js');
  const argv = ['bun', script, '--api-sock', apiSocket(dir), log, status];

  const writeNote = (line: string): void => {
    appendFileSync(log, `${line}\n`);
  };

  writeFileSync(script, STAND_IN);
  writeFileSync(log, '');

  const plans: unknown[] = [];

  const jails: Jails = {
    prepare: (plan) => {
      plans.push(plan);

      writeNote(
        `prepare late=${String(plan.isDiskLate)} disk=${String(existsSync(plan.paths.disk))}`,
      );

      return Promise.resolve(argv);
    },
    prepareBuild: (plan) => {
      plans.push(plan);

      writeNote(`prepare build ${plan.id}`);

      return Promise.resolve(argv);
    },
    setupDiskOwner: (paths) => {
      writeNote(`own disk=${String(existsSync(paths.disk))}`);
    },
    release: (id) => {
      writeNote(`release ${id}`);

      return Promise.resolve();
    },
    sweepRunDir: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    removeOrphans: () => Promise.resolve([]),
    seal: () => {
      writeNote('seal');
    },
  };

  return {
    dir,
    jails,
    plans,
    writeNote,
    readCalls: () => readFileSync(log, 'utf8').trim().split('\n'),
    [Symbol.dispose]() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// the agent parked until a claim, then booted on; old enough to snapshot
function startParkedAgent(vsockSocket: string) {
  const claimed = { isClaimed: false };

  return startStubAgent(vsockSocket, (socket, request) => {
    const isClaim = JSON.stringify(decodeJsonPayload(request)).includes('"op":"claim"');

    claimed.isClaimed ||= isClaim;

    const reply = !isClaim && !claimed.isClaimed ? { stage: 'template' } : {};

    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        ok: true,
        version: '0.1.0',
        uptime_ms: 60_000,
        ...reply,
      }),
    );
  });
}

// the start removes a stale vsock socket: the agent comes once the API is up
async function startAgentWhenUp(apiSocket: string, vsockSocket: string) {
  while (!existsSync(apiSocket)) {
    await Bun.sleep(2);
  }

  return startParkedAgent(vsockSocket);
}

function buildRestorePlan(dir: string, diskReady: Promise<number>): TemplateRestorePlan {
  const paths = buildImpPaths(dir, 'i1');

  mkdirSync(paths.runDir, { recursive: true });

  return {
    firecrackerBin: 'firecracker',
    paths,
    vmstate: join(dir, 'tpl', 'vmstate'),
    memFile: join(dir, 'tpl', 'mem'),
    systemDrivePath: join(dir, 'drives', 'system.squashfs'),
    placeholderPath: join(dir, 'tpl', 'placeholder.ext4'),
    diskPath: paths.disk,
    tap: 'imp-t0',
    cgroup: null,
    jail: JAIL,
    diskReady,
    claim: {
      id: 'i1',
      hostname: 'dev',
      ip: '10.66.0.2/30',
      gw: '10.66.0.1',
      ip6: null,
      gw6: null,
      dns: ['1.1.1.1'],
      mac: '06:00:0a:42:00:02',
      seed: new Uint8Array(64),
      isIdentityReset: false,
    },
  };
}

function buildBuildPlan(dir: string): TemplateBuildPlan {
  const workDir = join(dir, '.build-1');
  const runDir = join(workDir, 'run');
  const snapshotDir = join(workDir, 'snapshot');

  mkdirSync(runDir, { recursive: true });

  return {
    firecrackerBin: 'firecracker',
    kernelPath: join(dir, 'vmlinux'),
    systemDrivePath: join(dir, 'system.squashfs'),
    bootArgs: 'console=ttyS0 imp.template=1',
    vcpus: 1,
    memoryMib: 128,
    workDir,
    paths: {
      runDir,
      apiSocket: join(runDir, 'api.sock'),
      vsockSocket: join(runDir, 'vsock.sock'),
      logFile: join(runDir, 'firecracker.log'),
      pidFile: join(runDir, 'pid'),
    },
    placeholderPath: join(dir, 'placeholder.ext4'),
    tap: 'imp-tpl',
    guestMac: '06:00:a9:fe:ff:fe',
    jailId: 'tpl-build',
    jail: OWN_USER,
    cgroup: null,
    minGuestUptimeMs: 0,
    snapshotDir,
    vmstate: join(snapshotDir, 'vmstate'),
    memFile: join(snapshotDir, 'mem'),
  };
}

test('a jailed restore owns its disk once the clone is done, before the drive patch', async () => {
  using ctx = setupTemplateTest((dir) => buildImpPaths(dir, 'i1').apiSocket);

  // the clone lands after the restore has started
  const diskReady = (async () => {
    await Bun.sleep(100);

    writeFileSync(buildImpPaths(ctx.dir, 'i1').disk, '');

    return 0;
  })();

  const plan = buildRestorePlan(ctx.dir, diskReady);
  const restoring = loadTemplateVm(plan, ctx.jails);

  const agent = await startAgentWhenUp(plan.paths.apiSocket, plan.paths.vsockSocket);

  try {
    const vm = await restoring;

    process.kill(vm.pid, 'SIGKILL');

    expect(ctx.readCalls()).toEqual([
      'prepare late=true disk=false',
      'PUT /snapshot/load',
      'seal',
      'PATCH /vm',
      'own disk=true',
      'PATCH /drives/rootfs',
      'GET /version',
    ]);

    // without the drive the snapshot names, every jailed load fails, and
    // the imp boots the kernel with no more than a log line
    expect(ctx.plans).toEqual([
      expect.objectContaining({
        impId: 'i1',
        user: JAIL,
        readOnlyFiles: [plan.vmstate, plan.memFile, plan.systemDrivePath],
        scratchFiles: [plan.placeholderPath],
        isDiskLate: true,
      }),
    ]);
  } finally {
    agent.close();
  }
});

test('a build releases its jail before its files go to root, readable by all', async () => {
  using ctx = setupTemplateTest((dir) => join(dir, '.build-1', 'run', 'api.sock'));

  const plan = buildBuildPlan(ctx.dir);

  const jails: Jails = {
    ...ctx.jails,

    // the release kills the build uid: the files are still the VM's then
    release: (id) => {
      const mode = existsSync(plan.memFile)
        ? (lstatSync(plan.memFile).mode & 0o777).toString(8)
        : 'none';

      ctx.writeNote(`release ${id} mem=${mode}`);

      return Promise.resolve();
    },
  };

  const building = buildTemplateVm(plan, jails);

  const agent = await startAgentWhenUp(plan.paths.apiSocket, plan.paths.vsockSocket);

  try {
    await building.catch((error: unknown) => {
      throw new Error(`${readErrorMessage(error)}\n${ctx.readCalls().join('\n')}`);
    });

    const calls = ctx.readCalls();

    expect(calls[0]).toBe('prepare build tpl-build');
    expect(calls.indexOf('seal')).toBeLessThan(calls.indexOf('PUT /actions'));
    expect(calls.at(-1)).toBe('release tpl-build mem=600');
    expect(lstatSync(plan.memFile).mode & 0o777).toBe(0o644);
    expect(lstatSync(plan.vmstate).mode & 0o777).toBe(0o644);

    expect(ctx.plans).toEqual([
      expect.objectContaining({
        id: 'tpl-build',
        user: OWN_USER,
        workDir: plan.workDir,
        readOnlyFiles: [plan.kernelPath, plan.systemDrivePath],
        scratchFiles: [plan.placeholderPath],
      }),
    ]);
  } finally {
    agent.close();
  }
});

test('a build that fails still releases its jail, and leaves no snapshot', async () => {
  using ctx = setupTemplateTest((dir) => join(dir, '.build-1', 'run', 'api.sock'), 'fail');

  const plan = buildBuildPlan(ctx.dir);

  const error = await readRejection(buildTemplateVm(plan, ctx.jails));

  expect(readErrorMessage(error)).toStartWith('template build failed');
  expect(ctx.readCalls().at(-1)).toBe('release tpl-build');
  expect(existsSync(plan.snapshotDir)).toBeFalse();
});
