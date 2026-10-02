import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { listImps, readInfo, requireImp, runImp, runShellInImp } from '../lib/imp-cli';
import { createImp, holdImp } from '../lib/imps';
import { runDevScript, runInContainer } from '../lib/instance';
import { setupSuite } from '../lib/setup-suite';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// IMP_KSM with real merges (docs/architecture/sleep-and-wake.md#8-ksm-sharing-identical-guest-pages).
// The suite never turns KSM on: CI does it on its own runner VM, and on any
// other host the suite skips, since KSM is global to the kernel.
const prefix = setupSuite('ksm');
const TINY = resolveImageName('e2e-tiny');
const names = [`${prefix}a`, `${prefix}b`];

// The same bytes in both guests, but no two pages alike within one: only a
// merge across the guests counts. 96 MiB of 9-byte lines; /dev/shm holds
// about 245 MiB in a 512 MiB guest.
const FILL_MIB = 96;
const FILL = `seq -w 1 ${String(Math.floor((FILL_MIB * 1024 ** 2) / 9))} > /dev/shm/fill`;

// what each guest then writes of its own: together past the budget below,
// so the governor must sleep one
const OWN_MIB = 160;

// low enough that the two guests' own data does not fit; boots reserve 20 %
const BUDGET_MIB = 384;

// guest mappings at least this large are guest memory
const GUEST_MAPPING_MIB = 256;

function readHostFile(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function checkKernelSupportsKsm(): boolean {
  const match = /^(?<major>\d+)\.(?<minor>\d+)/u.exec(release());
  const major = Number(match?.groups?.['major'] ?? 0);
  const minor = Number(match?.groups?.['minor'] ?? 0);

  return major > 6 || (major === 6 && minor >= 10);
}

const KSM_READY = readHostFile('/sys/kernel/mm/ksm/run') === '1' && checkKernelSupportsKsm();

// ksmd's CPU time on this host, in ms (USER_HZ is 100)
function readKsmdCpuMs(): number {
  const pid = Bun.spawnSync(['pgrep', '-x', 'ksmd']).stdout.toString().trim();
  const stat = readHostFile(`/proc/${pid}/stat`);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

  return (Number(fields[11]) + Number(fields[12])) * 10;
}

async function readContainerText(argv: readonly string[]): Promise<string> {
  const result = await runInContainer(argv);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }

  return result.stdout.trim();
}

async function readFirecrackerPid(name: string): Promise<string> {
  const imp = await requireImp(name);

  return readContainerText(['cat', `/var/lib/imp/imps/${imp.id}/run/pid`]);
}

// what the governor counts for the VM: Pss_Anon + Pss_Shmem, in MiB
async function readPssMib(name: string): Promise<number> {
  const pid = await readFirecrackerPid(name);
  const rollup = await readContainerText(['cat', `/proc/${pid}/smaps_rollup`]);

  const readKb = (field: string): number =>
    Number(new RegExp(`^${field}:\\s+(?<kb>\\d+) kB$`, 'mu').exec(rollup)?.groups?.['kb'] ?? 0);

  return Math.round((readKb('Pss_Anon') + readKb('Pss_Shmem')) / 1024);
}

async function readMergingPages(name: string): Promise<number> {
  const pid = await readFirecrackerPid(name);
  const text = await readContainerText(['cat', `/proc/${pid}/ksm_merging_pages`]);

  return Number(text);
}

// the permissions and flags of the VM's guest memory mappings: rw-s (memfd)
// memory would never merge
async function readGuestMappings(name: string): Promise<string[]> {
  const pid = await readFirecrackerPid(name);
  const smaps = await readContainerText(['cat', `/proc/${pid}/smaps`]);

  const mappings: string[] = [];
  const current = { perms: '', large: false };

  for (const line of smaps.split('\n')) {
    const header = /^(?<start>[\da-f]+)-(?<end>[\da-f]+) (?<perms>\S+) /u.exec(line);

    if (header?.groups !== undefined) {
      const bytes =
        Number.parseInt(header.groups['end'] ?? '0', 16) -
        Number.parseInt(header.groups['start'] ?? '0', 16);

      current.perms = header.groups['perms'] ?? '';
      current.large = bytes >= GUEST_MAPPING_MIB * 1024 ** 2;
    } else if (line.startsWith('VmFlags:') && current.large) {
      mappings.push(`${current.perms}${line.includes(' mg') ? ' mg' : ''}`);
    }
  }

  return mappings;
}

// the governor's measure for every awake guest of the suite, read from /proc
async function readAwakePssMib(): Promise<number> {
  const rows = await listImps();

  const awake = rows.filter((row) => names.includes(row.name) && row.state === 'running');

  const pss = await Promise.all(awake.map((row) => readPssMib(row.name)));

  return pss.reduce((sum, mib) => sum + mib, 0);
}

function countMib(mibs: readonly number[]): number {
  return mibs.reduce((sum, mib) => sum + mib, 0);
}

beforeAll(async () => {
  if (!KSM_READY) {
    return;
  }

  // a budget the guests can pass, and no idle sleeps to hide it
  Object.assign(process.env, {
    IMP_KSM: '1',
    IMP_RAM_BUDGET_MIB: String(BUDGET_MIB),
    IMP_BOOT_RESERVE_PERCENT: '20',
    IMP_IDLE_TIMEOUT_S: '600',
  });

  await runDevScript('reboot');
}, 600_000);

afterAll(async () => {
  if (!KSM_READY) {
    return;
  }

  Object.assign(process.env, {
    IMP_RAM_BUDGET_MIB: String(config.ramBudgetMib),
    IMP_IDLE_TIMEOUT_S: String(config.idleTimeoutS),
  });

  delete process.env['IMP_KSM'];
  delete process.env['IMP_BOOT_RESERVE_PERCENT'];

  await runDevScript('reboot');
}, 600_000);

test.skipIf(!KSM_READY)(
  'two guests that hold the same pages merge them across each other, and their Pss falls',
  async () => {
    const cpuBefore = readKsmdCpuMs();

    for (const name of names) {
      await createImp(name, '--image', TINY, '--memory', '512m');
      await holdImp(name);
    }

    const mappings = await Promise.all(names.map((name) => readGuestMappings(name)));

    // private and mergeable, so memfd-backed memory would fail here
    expect(mappings.flat().length).toBeGreaterThan(0);
    expect(new Set(mappings.flat())).toEqual(new Set(['rw-p mg']));

    for (const name of names) {
      await runShellInImp(name, FILL);
    }

    const before = await Promise.all(names.map((name) => readPssMib(name)));

    const merged = await waitFor(
      'KSM to merge the guests',
      async () => {
        const pages = await Promise.all(names.map((name) => readMergingPages(name)));

        // most of each guest's fill, in 4 KiB pages
        expect(Math.min(...pages)).toBeGreaterThan((FILL_MIB * 256) / 2);

        return pages;
      },
      { timeoutMs: 300_000, intervalMs: 2000 },
    );

    const after = await Promise.all(names.map((name) => readPssMib(name)));
    const info = await readInfo();

    writeMetric('ksm_merging_pages', merged);
    writeMetric('ksm_pss_before_mib', before);
    writeMetric('ksm_pss_after_mib', after);
    writeMetric('ksm_ksmd_cpu_ms', readKsmdCpuMs() - cpuBefore);
    writeMetric('ksm_info', info.ksm);

    // a metric until the CI kernel is known to keep the flag (590c03ca6a3f)
    writeMetric('ksm_unmergeable', info.ksm?.unmergeable);

    // the shared fill counts half in each guest
    expect(countMib(after)).toBeLessThan(countMib(before) - FILL_MIB / 2);
    expect(info.ksm?.headroomMib).toBeGreaterThan(0);
  },
  600_000,
);

test.skipIf(!KSM_READY)(
  'when the guests write their own pages past the budget, the governor keeps the budget',
  async () => {
    for (const name of names) {
      await runImp('hold', name, '0');
    }

    // the fill goes first: /dev/shm cannot hold both
    for (const name of names) {
      await runShellInImp(
        name,
        `rm /dev/shm/fill && head -c ${String(OWN_MIB)}M /dev/urandom > /dev/shm/own`,
      );
    }

    // two governor ticks after the last write
    await Bun.sleep(12_000);

    const awakeMib = await readAwakePssMib();
    const rows = await listImps();

    const states = rows.filter((row) => names.includes(row.name)).map((row) => row.state);

    writeMetric('ksm_after_split', { awakeMib, states });

    expect(awakeMib).toBeLessThanOrEqual(BUDGET_MIB);

    for (const name of names) {
      await runImp('rm', name);
    }
  },
  600_000,
);
