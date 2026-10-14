import { expect, onTestFinished, test } from 'bun:test';
import { ENFORCE_INTERVAL_MS } from '../../packages/daemon/src/governor/ram-governor';
import { config } from '../lib/config';
import { resolveImageName } from '../lib/fixtures';
import { readPluggedMib } from '../lib/guest-memory';
import { createInstanceClient, listImps, readInfo, runImp, runShellInImp } from '../lib/imp-cli';
import { holdImp, waitForExec } from '../lib/imps';
import {
  checkHostRunsKsm,
  readGuestMappings,
  readKsmdCpuMs,
  readMergingPages,
  readVmPssMib,
} from '../lib/ksm-host';
import { registerRemoval } from '../lib/register-removal';
import { removeImpIfPresent } from '../lib/reset-baseline';
import { readSuitePrefix } from '../lib/suites';
import { waitFor } from '../lib/wait-for';
import { writeMetric } from '../lib/write-metric';

// IMP_KSM with real merges (docs/architecture/sleep-and-wake.md#8-ksm-sharing-identical-guest-pages).
// KSM is global to the kernel: CI turns it on, and on any other host the
// suite skips. Its settings put the instance on KSM and a 512 MiB budget.

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const client = await createInstanceClient();

  return { prefix: readSuitePrefix('ksm'), stack, client };
}

test.skipIf(!checkHostRunsKsm())(
  'it merges the pages two guests hold alike, and the governor keeps the budget once their own writes split them',
  async () => {
    const ctx = await setupTest();

    const image = resolveImageName('e2e-tiny');
    const a = `${ctx.prefix}a`;
    const b = `${ctx.prefix}b`;
    const cpuBefore = readKsmdCpuMs();

    await runImp('new', a, '--image', image, '--memory', '512m');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, a));

    await waitForExec(a);
    await holdImp(a);
    await runImp('new', b, '--image', image, '--memory', '512m');

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, b));

    await waitForExec(b);
    await holdImp(b);

    const mappingsA = await readGuestMappings(a);
    const mappingsB = await readGuestMappings(b);

    // private and mergeable: memfd-backed memory would fail here
    expect(new Set([...mappingsA, ...mappingsB])).toStrictEqual(new Set(['rw-p mg']));

    // before the fill, so no merge of it has begun yet
    const beforeA = await readVmPssMib(a);
    const beforeB = await readVmPssMib(b);

    // 96 MiB of 9-byte lines, the same in both guests but no two pages alike
    // within one: only a merge across the guests counts
    const fill = `seq -w 1 ${String(Math.floor((96 * 1024 ** 2) / 9))} > /dev/shm/fill`;

    await runShellInImp(a, fill);
    await runShellInImp(b, fill);

    const merge = await waitFor(
      'KSM to merge the guests',
      async () => {
        const pagesA = await readMergingPages(a);
        const pagesB = await readMergingPages(b);
        const pssA = await readVmPssMib(a);
        const pssB = await readVmPssMib(b);

        // most of each fill, in 4 KiB pages; unmerged, the fills add 192 MiB,
        // and the shared fill counts half in each guest
        if (Math.min(pagesA, pagesB) <= (96 * 256) / 2 || pssA + pssB >= beforeA + beforeB + 144) {
          throw new Error(
            `merging ${String(pagesA)} and ${String(pagesB)} pages, Pss ${String(pssA + pssB)} MiB`,
          );
        }

        return { merged: [pagesA, pagesB], after: [pssA, pssB] };
      },
      { timeoutMs: 300_000, intervalMs: 2000 },
    );

    const info = await readInfo();

    writeMetric('ksm_merging_pages', merge.merged);
    writeMetric('ksm_pss_before_fill_mib', [beforeA, beforeB]);
    writeMetric('ksm_pss_after_mib', merge.after);
    writeMetric('ksm_ksmd_cpu_ms', readKsmdCpuMs() - cpuBefore);
    writeMetric('ksm_info', info.ksm);

    // a metric until the CI kernel is known to keep the flag (590c03ca6a3f)
    writeMetric('ksm_unmergeable', info.ksm?.unmergeable);

    expect(info.ksm?.headroomMib).toBeGreaterThan(0);

    await runImp('hold', a, '0');
    await runImp('hold', b, '0');

    // The fill goes first, so the merged pages split; then 288 MiB of each
    // guest's own: the two pass the budget even without their base, one fits.
    // /dev/shm grows past half the guest's RAM; busybox head takes no 'M'.
    const ownWrite = [
      'rm /dev/shm/fill',
      'mount -o remount,size=320m /dev/shm',
      'dd if=/dev/urandom of=/dev/shm/own bs=1M count=288',
    ].join(' && ');

    await runShellInImp(a, ownWrite);
    await runShellInImp(b, ownWrite);

    // two enforce passes, and 2 s to read every guest's Pss: the most a
    // breach may last after the last write
    const awakeMib = await waitFor(
      'the governor to keep the guests within the budget',
      async () => {
        const rows = await listImps();

        const awake = rows.filter((row) => [a, b].includes(row.name) && row.state === 'running');

        const pss = await Promise.all(awake.map((row) => readVmPssMib(row.name)));

        const mib = pss.reduce((sum, one) => sum + one, 0);

        if (mib > 512) {
          throw new Error(`${String(mib)} MiB awake, over the 512 MiB budget`);
        }

        return mib;
      },
      { timeoutMs: 2 * ENFORCE_INTERVAL_MS + 2000, intervalMs: 500 },
    );

    const rows = await listImps();

    const states = rows.filter((row) => [a, b].includes(row.name)).map((row) => row.state);

    writeMetric('ksm_after_split', { awakeMib, states });

    expect(awakeMib).toBeLessThanOrEqual(512);
  },
  600_000,
);

// Plugged memory is guest memory KSM may merge, as its boot memory is
// (docs/architecture/memory.md#how-the-guest-grows).
test.skipIf(!checkHostRunsKsm())(
  'it makes the memory an elastic guest grows into private and mergeable, as its boot memory is',
  async () => {
    const ctx = await setupTest();

    const name = `${ctx.prefix}grow`;

    await runImp(
      'new',
      name,
      '--image',
      resolveImageName('e2e-tiny'),
      '--memory',
      '192m',
      '--max-memory',
      '448m',
    );

    registerRemoval(ctx.stack, config.keep, () => removeImpIfPresent(ctx.client, name));

    await waitForExec(name);
    await holdImp(name);

    // 120 MiB in tmpfs at 20 MiB a second, a rate the guest grows at: past
    // what the base holds free
    await runShellInImp(
      name,
      'mkdir -p /mnt/fill && mount -t tmpfs -o size=200m tmpfs /mnt/fill && ' +
        'i=0; while [ $i -lt 6 ]; do dd if=/dev/zero of=/mnt/fill/$i bs=1M count=20 2>/dev/null || exit 1; i=$((i+1)); sleep 1; done',
    );

    const growStarted = performance.now();

    // the grow can land after the fill ends, so wait for it rather than
    // read the plugged size once
    await waitFor(
      `${name} to grow under the fill`,
      async () => {
        const pluggedMib = await readPluggedMib(name);

        if (pluggedMib < 256) {
          throw new Error(`${String(pluggedMib)} MiB plugged`);
        }
      },
      { timeoutMs: 30_000, intervalMs: 200 },
    );

    writeMetric('ksm_grow_after_fill_ms', Math.round(performance.now() - growStarted));

    const mappings = await readGuestMappings(name);

    writeMetric('ksm_elastic_mappings', mappings);

    expect(new Set(mappings)).toStrictEqual(new Set(['rw-p mg']));
  },
  600_000,
);
