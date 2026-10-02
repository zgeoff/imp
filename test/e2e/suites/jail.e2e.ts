import { afterAll, expect, test } from 'bun:test';
import { VmIdentitySchema } from '../../../packages/daemon/src/sleep/vm-identity';
import { buildTemplateKey } from '../../../packages/daemon/src/templates/boot-templates';
import { resolveImageName } from '../lib/fixtures';
import { assertState, requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { createImp, holdImp, waitForExec } from '../lib/imps';
import { checkHealthReady, readImpdLogSince, runDevScript, runInContainer } from '../lib/instance';
import type { MemoryProof } from '../lib/memory-proof';
import { checkMemoryProof, startMemoryProof } from '../lib/memory-proof';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';

const prefix = setupSuite('jail');
const BARE = resolveImageName('e2e-bare');
const name = `${prefix}box`;
const MIB = 1024 * 1024;
const MEMORY_MIB = 512;

// guest memory a tmpfs fills before a sleep: most of the VM's RAM
const FILL_MIB = 380;
let proof: MemoryProof;

interface VmProcess {
  readonly pid: string;
  readonly cmdline: string;
  readonly status: string;
}

async function readContainerFile(path: string): Promise<string> {
  const result = await runInContainer(['cat', path]);

  if (result.exitCode !== 0) {
    throw new Error(`cat ${path} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

// The imp's Firecracker: jailed, its argv starts `/firecracker --id <id>`;
// otherwise it names the imp's directory.
async function readVmProcess(): Promise<VmProcess> {
  const row = await requireImp(name);
  const found = await runInContainer(['pgrep', '-f', `firecracker.*imps/${row.id}/`]);

  const pid = found.stdout.split('\n')[0]?.trim() ?? '';

  if (pid === '') {
    throw new Error(`no firecracker for ${name}`);
  }

  const cmdline = await readContainerFile(`/proc/${pid}/cmdline`);
  const status = await readContainerFile(`/proc/${pid}/status`);

  return { pid, cmdline: cmdline.replaceAll('\0', ' '), status };
}

function readStatusField(status: string, field: string): string {
  return new RegExp(`^${field}:\\s+(?<value>.*)$`, 'mv').exec(status)?.groups?.['value'] ?? '';
}

async function readCgroupFile(file: string): Promise<string> {
  const row = await requireImp(name);

  return readContainerFile(`/sys/fs/cgroup/imps/${row.id}/${file}`);
}

// every thread of the VM: Firecracker installs its filters per thread
async function listSeccompModes(pid: string): Promise<readonly string[]> {
  const result = await runInContainer([
    'sh',
    '-c',
    `grep -h '^Seccomp:' /proc/${pid}/task/*/status | awk '{print $2}'`,
  ]);

  return result.stdout.trim().split('\n');
}

async function checkJailed(vm: Readonly<VmProcess>): Promise<void> {
  const row = await requireImp(name);

  const uid = readStatusField(vm.status, 'Uid').split(/\s+/)[0] ?? '';

  expect(vm.cmdline).toStartWith(`/firecracker --id ${row.id} `);
  expect(vm.cmdline).toContain(`--api-sock /var/lib/imp/imps/${row.id}/run/api.sock`);
  expect(Number(uid)).toBeGreaterThanOrEqual(900_000);
  expect(readStatusField(vm.status, 'CapEff')).toBe('0000000000000000');

  const modes = await listSeccompModes(vm.pid);

  expect(modes.length).toBeGreaterThan(1);
  expect(modes.every((mode) => mode === '2')).toBeTrue();

  const owner = await readContainerFile(`/sys/class/net/imp${String(row.slot)}/owner`);

  expect(owner).toBe(uid);

  // sealed before the guest ran: the VM can no longer change run/ or the snapshot dir
  const dirs = await runInContainer([
    'stat',
    '-c',
    '%u',
    `/var/lib/imp/imps/${row.id}/run`,
    `/var/lib/imp/imps/${row.id}/snapshot`,
  ]);

  expect(dirs.stdout.trim().split('\n')).toEqual(['0', '0']);
}

async function waitForRam(): Promise<void> {
  await waitFor(`a RAM sample for ${name}`, async () => {
    const row = await requireImp(name);

    expect(row.ramMib).toBeGreaterThan(0);
  });
}

async function checkNoJailMounts(id = ''): Promise<void> {
  const mounts = await readContainerFile('/proc/self/mounts');

  expect(mounts).not.toContain(` /var/lib/imp/jail/${id}`);
}

// The imp's own jail: a boot template build, which the second cold boot of a
// shape starts in the background, has its jail mounted while it runs.
async function checkNoImpJailMounts(): Promise<void> {
  const row = await requireImp(name);

  await checkNoJailMounts(`firecracker/${row.id}/`);
}

// The key of the imp's boot template: its shape, and the host as its last
// cold boot saw it (vm.json), the way impd keys it
async function readTemplateKey(): Promise<string> {
  const row = await requireImp(name);
  const text = await readContainerFile(`/var/lib/imp/imps/${row.id}/vm.json`);

  const identity = VmIdentitySchema.required({ cpuModel: true, cpuFlags: true }).parse(
    JSON.parse(text),
  );

  return buildTemplateKey(identity, { vcpus: row.vcpus, memoryMib: row.memoryMib });
}

// A cold boot from `since` on started a build of the key, which impd logs the
// end of: built, refused or failed. A restore of a template made earlier
// started none.
async function waitForTemplateBuildEnd(since: Readonly<Date>, key: string): Promise<void> {
  const ended = new RegExp(
    `impd: boot template ${key.slice(0, 12)} (?:built in|build refused|build failed)`,
    'v',
  );

  await waitFor('the boot template build to end', async () => {
    const log = await readImpdLogSince(since);

    if (log.includes(`${name}: restored boot template`)) {
      return;
    }

    expect(log).toMatch(ended);
  });
}

async function checkNoOomKills(): Promise<void> {
  const events = await readCgroupFile('memory.events');

  expect(events).toMatch(/^oom_kill 0$/m);
}

async function checkRunsJailed(): Promise<void> {
  const vm = await readVmProcess();

  await checkJailed(vm);
}

afterAll(async () => {
  delete process.env['IMP_JAILER'];

  await runDevScript('reboot');
}, 600_000);

test('a new imp runs jailed: its own uid, no capabilities, seccomp on every thread', async () => {
  await createImp(name, '--image', BARE, '--memory', String(MEMORY_MIB));
  await holdImp(name);

  const vm = await readVmProcess();

  await checkJailed(vm);
  await waitForRam();
});

test('its cgroup caps memory a little over the guest, with no swap', async () => {
  const max = await readCgroupFile('memory.max');
  const high = await readCgroupFile('memory.high');

  expect(Number(max)).toBe((MEMORY_MIB + 256) * MIB);
  expect(high).toBe('max');

  const swapMax = await readCgroupFile('memory.swap.max');
  const oomGroup = await readCgroupFile('memory.oom.group');

  expect(swapMax).toBe('0');
  expect(oomGroup).toBe('1');
});

test('a full guest sleeps and wakes under the limit', async () => {
  proof = await startMemoryProof(name);

  await runShellInImp(
    name,
    [
      `mkdir -p /run/fill && mount -t tmpfs -o size=${String(FILL_MIB + 10)}m tmpfs /run/fill`,
      `dd if=/dev/zero of=/run/fill/f bs=1M count=${String(FILL_MIB)} 2>/dev/null`,
    ].join('\n'),
  );

  await runImp('sleep', name);
  await assertState(name, 'sleeping');
  await checkNoOomKills();
  await checkNoImpJailMounts();
  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);

  // every page of the fill back in the VM, not only those the wake touched
  const size = await runShellInImp(name, 'cat /run/fill/f | wc -c');

  expect(Number(size)).toBe(FILL_MIB * MIB);

  await checkNoOomKills();

  const peak = await readCgroupFile('memory.peak');

  expect(Number(peak)).toBeLessThanOrEqual((MEMORY_MIB + 256) * MIB);

  await checkRunsJailed();
});

test('an impd restart re-adopts the jailed VM, with its RAM stats', async () => {
  const before = await readVmProcess();

  await runDevScript('restart');

  await waitFor('impd to be ready', async () => {
    const isReady = await checkHealthReady();

    expect(isReady).toBeTrue();
  });

  const after = await readVmProcess();

  expect(after.pid).toBe(before.pid);

  await assertState(name, 'running');
  await checkMemoryProof(proof);
  await waitForRam();
});

test('rollback: an impd without the jailer wakes a jailed snapshot', async () => {
  process.env['IMP_JAILER'] = 'false';

  // the old impd sleeps the VM; the new one runs Firecracker as root
  await runDevScript('reboot');
  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);

  const vm = await readVmProcess();

  expect(vm.cmdline).not.toContain('--id');
  expect(readStatusField(vm.status, 'Uid').split(/\s+/)[0]).toBe('0');
});

test('upgrade: an unjailed snapshot wakes jailed', async () => {
  delete process.env['IMP_JAILER'];

  await runDevScript('reboot');
  await runImp('wake', name);
  await waitForExec(name);
  await checkMemoryProof(proof);
  await checkRunsJailed();
});

test('a VM over its memory limit is stopped, and says why', async () => {
  const row = await requireImp(name);

  await runInContainer([
    'sh',
    '-c',
    `echo ${String(128 * MIB)} > /sys/fs/cgroup/imps/${row.id}/memory.max`,
  ]);

  // A woken VM maps its memory from the snapshot file, which the host can
  // drop; a write makes each page the VM's own, and there is no room for it.
  await runShellInImp(
    name,
    `dd if=/dev/zero of=/run/fill/f bs=1M count=${String(FILL_MIB)} conv=notrunc`,
  ).catch(() => '');

  await waitFor(`${name} to stop`, () => assertState(name, 'stopped'));

  const stopped = await requireImp(name);

  expect(stopped.error).toBe('its memory limit killed firecracker');

  await checkNoImpJailMounts();
});

test('a jailed VM starts, stops and is removed cleanly', async () => {
  await runImp('start', name);
  await waitForExec(name);
  await checkRunsJailed();
  await runImp('stop', name);
  await assertState(name, 'stopped');
  await checkNoImpJailMounts();

  const row = await requireImp(name);

  const since = new Date();

  // the second cold boot of the shape since the last impd start: it starts a
  // jailed boot template build in the background
  await runImp('start', name);
  await waitForExec(name);

  const key = await readTemplateKey();

  // a destroy kills the VM outright
  await runImp('rm', name);

  const jail = await runInContainer(['ls', `/var/lib/imp/jail/firecracker/${row.id}`]);
  const cgroup = await runInContainer(['ls', `/sys/fs/cgroup/imps/${row.id}`]);

  expect(jail.exitCode).not.toBe(0);
  expect(cgroup.exitCode).not.toBe(0);

  await checkNoJailMounts(`firecracker/${row.id}/`);

  // once the build ends, it leaves no jail mounted either
  await waitForTemplateBuildEnd(since, key);
  await checkNoJailMounts();
});
