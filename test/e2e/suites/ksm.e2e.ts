import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { release } from 'node:os';
import { resolveImageName } from '../lib/fixtures';
import { readInfo, requireImp, runImp, runShellInImp } from '../lib/imp-cli';
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

// both guests fill this much tmpfs with the same pages, then with their own
const FILL_MIB = 128;

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

beforeAll(async () => {
  if (!KSM_READY) {
    return;
  }

  process.env['IMP_KSM'] = '1';

  await runDevScript('reboot');
}, 600_000);

afterAll(async () => {
  if (!KSM_READY) {
    return;
  }

  delete process.env['IMP_KSM'];

  await runDevScript('reboot');
}, 600_000);

test.skipIf(!KSM_READY)(
  'two guests that hold the same pages merge them, and their Pss falls',
  async () => {
    const cpuBefore = readKsmdCpuMs();

    for (const name of names) {
      await createImp(name, '--image', TINY, '--memory', '512m');
      await holdImp(name);
    }

    // every 4 KiB page of `yes` output is the same page
    for (const name of names) {
      await runShellInImp(name, `yes ksm | head -c ${String(FILL_MIB)}M > /dev/shm/fill`);
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

    expect(after.reduce((sum, mib) => sum + mib, 0)).toBeLessThan(
      before.reduce((sum, mib) => sum + mib, 0) - FILL_MIB,
    );

    expect(info.ksm?.unmergeable).toBe(0);
    expect(info.ksm?.headroomMib).toBeGreaterThan(0);
  },
  600_000,
);

test.skipIf(!KSM_READY)(
  'when the guests write their own pages, the budget still holds',
  async () => {
    for (const name of names) {
      await runShellInImp(
        name,
        `head -c ${String(FILL_MIB)}M /dev/urandom > /dev/shm/own && rm /dev/shm/fill`,
      );
    }

    // one governor tick after the split
    await Bun.sleep(6000);

    const info = await readInfo();

    writeMetric('ksm_after_split', { usedMib: info.ramUsedMib, ksm: info.ksm });

    expect(info.ramUsedMib + (info.ksm?.headroomMib ?? 0)).toBeLessThanOrEqual(info.ramBudgetMib);

    await runImp('rm', names[0] ?? '');
    await runImp('rm', names[1] ?? '');
  },
  600_000,
);
