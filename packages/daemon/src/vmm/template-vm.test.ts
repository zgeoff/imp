import { expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeAgent } from '../agent-client/fake-agent';
import { FRAME_TYPES, decodeJsonPayload, encodeJsonFrame } from '../agent-client/frame-codec';
import { buildImpPaths } from '../storage/data-layout';
import type { Jails } from './jail';
import { loadTemplateVm } from './template-vm';

// A Firecracker stand-in: an API on the socket its argv names, which logs
// each call to `log` and answers what a restore asks.
const STAND_IN = `
const [apiSocket, log] = process.argv.slice(-2);
const { appendFileSync } = require('node:fs');
Bun.serve({
  unix: apiSocket,
  fetch: (request) => {
    appendFileSync(log, request.method + ' ' + new URL(request.url).pathname + '\\n');
    const isVersion = new URL(request.url).pathname === '/version';
    return isVersion
      ? Response.json({ firecracker_version: 'v1.17.0' })
      : new Response(null, { status: 204 });
  },
});
`;

test('a jailed restore owns its disk once the clone is done, before the drive patch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imp-tpl-vm-'));
  const paths = buildImpPaths(dir, 'i1');
  const log = join(dir, 'calls.log');
  const script = join(dir, 'firecracker.js');

  const writeNote = (line: string): void => {
    appendFileSync(log, `${line}\n`);
  };

  mkdirSync(paths.runDir, { recursive: true });
  writeFileSync(script, STAND_IN);
  writeFileSync(log, '');

  const jails: Jails = {
    prepare: (plan) => {
      writeNote(`prepare late=${String(plan.isDiskLate)} disk=${String(existsSync(paths.disk))}`);

      return Promise.resolve(['bun', script, '--api-sock', paths.apiSocket, log]);
    },
    prepareBuild: () => Promise.reject(new Error('no build here')),
    setupDiskOwner: () => {
      writeNote(`own disk=${String(existsSync(paths.disk))}`);
    },
    release: () => Promise.resolve(),
    sweepRunDir: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    removeOrphans: () => Promise.resolve([]),
    seal: () => {
      writeNote('seal');
    },
  };

  const claimed = { isClaimed: false };

  // the agent parked until the claim, then booted on
  const startAgent = () =>
    startFakeAgent(paths.vsockSocket, (socket, request) => {
      const isClaim = JSON.stringify(decodeJsonPayload(request)).includes('"op":"claim"');

      claimed.isClaimed ||= isClaim;

      const reply = !isClaim && !claimed.isClaimed ? { stage: 'template' } : {};

      socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true, version: '0.1.0', ...reply }));
    });

  // the clone lands after the restore has started
  const diskReady = (async () => {
    await Bun.sleep(100);

    writeFileSync(paths.disk, '');

    return 0;
  })();

  const restoring = loadTemplateVm(
    {
      firecrackerBin: 'firecracker',
      paths,
      vmstate: join(dir, 'vmstate'),
      memFile: join(dir, 'mem'),
      systemDrivePath: join(dir, 'system.squashfs'),
      placeholderPath: join(dir, 'placeholder.ext4'),
      diskPath: paths.disk,
      tap: 'imp-t0',
      cgroup: null,
      jail: { uid: 900_001, gid: 900_001 },
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
    },
    jails,
  );

  // the start removes a stale vsock socket: the agent comes after it
  while (!existsSync(paths.apiSocket)) {
    await Bun.sleep(2);
  }

  const agent = await startAgent();

  try {
    const vm = await restoring;

    process.kill(vm.pid, 'SIGKILL');

    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'prepare late=true disk=false',
      'PUT /snapshot/load',
      'seal',
      'PATCH /vm',
      'own disk=true',
      'PATCH /drives/rootfs',
      'GET /version',
    ]);
  } finally {
    agent.close();

    rmSync(dir, { recursive: true, force: true });
  }
});
