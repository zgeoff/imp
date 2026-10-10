import { requireImp } from './imp-cli';
import { runInContainer } from './instance';

// What the host container shows of an imp's Firecracker and its jail
// (docs/architecture/host-contract.md): read over a live instance, then
// judged by the pure functions below.

export interface JailState {
  readonly impId: string;

  // the VM's argv, NULs as spaces
  readonly cmdline: string;
  readonly uid: string;
  readonly capEff: string;

  // each thread's Seccomp mode: Firecracker installs its filters per thread
  readonly seccompModes: readonly string[];

  // the uid that owns the imp's tap
  readonly tapOwner: string;

  // the owners of the imp's run/ and snapshot/ dirs
  readonly sealedOwners: readonly string[];
}

// a field of /proc/<pid>/status, or '' when the status lacks it
export function readStatusField(status: string, field: string): string {
  return new RegExp(`^${field}:\\s+(?<value>.*)$`, 'mv').exec(status)?.groups?.['value'] ?? '';
}

// The ways a VM breaks the jail's contract, empty for a jailed one: the
// jailer's argv, a uid of 900000 or more, no capabilities, seccomp on every
// thread, its own tap, and run/ and snapshot/ sealed to root.
export function findJailViolations(state: Readonly<JailState>): readonly string[] {
  const checks: readonly (readonly [boolean, string])[] = [
    [state.cmdline.startsWith(`/firecracker --id ${state.impId} `), 'not started by the jailer'],
    [
      state.cmdline.includes(`--api-sock /var/lib/imp/imps/${state.impId}/run/api.sock`),
      'another API socket',
    ],
    [Number(state.uid) >= 900_000, `uid ${state.uid}`],
    [state.capEff === '0000000000000000', `capabilities ${state.capEff}`],
    [state.seccompModes.length > 1, `${String(state.seccompModes.length)} threads`],
    [state.seccompModes.every((mode) => mode === '2'), `seccomp ${state.seccompModes.join(',')}`],
    [state.tapOwner === state.uid, `tap owned by ${state.tapOwner}`],
    [
      state.sealedOwners.join(',') === '0,0',
      `run/ and snapshot/ owned by ${state.sealedOwners.join(',')}`,
    ],
  ];

  return checks.filter(([isKept]) => !isKept).map(([, violation]) => violation);
}

// Thin glue over the host container below.

// a file in the host container, trimmed; throws when it cannot be read
async function readContainerText(path: string): Promise<string> {
  const result = await runInContainer(['cat', path]);

  if (result.exitCode !== 0) {
    throw new Error(`cat ${path} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

export interface VmProcess {
  readonly pid: string;
  readonly cmdline: string;
  readonly status: string;
}

// The imp's Firecracker: jailed, its argv starts `/firecracker --id <id>`;
// otherwise it names the imp's directory.
export async function readVmProcess(name: string): Promise<VmProcess> {
  const row = await requireImp(name);
  const found = await runInContainer(['pgrep', '-f', `firecracker.*imps/${row.id}/`]);

  const pid = found.stdout.split('\n')[0]?.trim() ?? '';

  if (pid === '') {
    throw new Error(`no firecracker for ${name}`);
  }

  const cmdline = await readContainerText(`/proc/${pid}/cmdline`);
  const status = await readContainerText(`/proc/${pid}/status`);

  return { pid, cmdline: cmdline.replaceAll('\0', ' '), status };
}

export async function readJailState(name: string): Promise<JailState> {
  const row = await requireImp(name);
  const vm = await readVmProcess(name);

  const modes = await runInContainer([
    'sh',
    '-c',
    `grep -h '^Seccomp:' /proc/${vm.pid}/task/*/status | awk '{print $2}'`,
  ]);

  const tapOwner = await readContainerText(`/sys/class/net/imp${String(row.slot)}/owner`);

  const sealed = await runInContainer([
    'stat',
    '-c',
    '%u',
    `/var/lib/imp/imps/${row.id}/run`,
    `/var/lib/imp/imps/${row.id}/snapshot`,
  ]);

  return {
    impId: row.id,
    cmdline: vm.cmdline,
    uid: readStatusField(vm.status, 'Uid').split(/\s+/v)[0] ?? '',
    capEff: readStatusField(vm.status, 'CapEff'),
    seccompModes: modes.stdout.trim().split('\n'),
    tapOwner,
    sealedOwners: sealed.stdout.trim().split('\n'),
  };
}

// a file of the imp's cgroup in the host container
export async function readImpCgroupText(name: string, file: string): Promise<string> {
  const row = await requireImp(name);

  return readContainerText(`/sys/fs/cgroup/imps/${row.id}/${file}`);
}

// the host container's mounts under a jail dir: none for an imp whose VM and
// boot template builds are gone
export async function listJailMounts(dir: string): Promise<readonly string[]> {
  const mounts = await readContainerText('/proc/self/mounts');

  return mounts.split('\n').filter((line) => line.includes(` /var/lib/imp/jail/${dir}`));
}
