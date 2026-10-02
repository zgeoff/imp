import type { SystemInfo } from '@imp/api';
import { defineCommand } from '../define-command';
import { formatBootStatus, formatJson } from '../format-output';
import { runAction } from '../run-action';
import { jsonArg } from './common-args';

export const infoCommand = defineCommand({
  meta: { name: 'info', description: 'Show impd version, RAM budget and counts' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const info = await client.system.info();

      if (context.args.json === true) {
        console.log(formatJson(info));

        return;
      }

      const lines = [
        ['version', info.version],
        ['imps', `${String(info.impCount)} (${String(info.awakeCount)} awake)`],
        ['sessions', String(info.sessionCount)],
        ['boot status', formatBootStatus(info.bootStatus, info.version)],
        [
          'ram',
          `${String(info.ramUsedMib)} / ${String(info.ramBudgetMib)} MiB (${String(info.ramReservedMib)} reserved, ${String(info.ramCommittedMib)} committed${formatSleeping(info.ramSleepingMib)})`,
        ],
        ['firecracker', info.firecrackerVersion ?? 'unknown'],
        [
          'kernel',
          `${info.guestKernel.version ?? 'unknown'} (sha256 ${info.guestKernel.sha256.slice(0, 12)})`,
        ],
        ['agent drive', `sha256 ${info.systemDrive.sha256.slice(0, 12)}`],
        [
          'storage',
          `${info.storage.backend}, ${formatGib(info.storage.usedBytes)} used, ${formatGib(info.storage.availableBytes)} free, ${formatGib(info.storage.reserveBytes)} reserved${info.storage.isLow ? ' (LOW)' : ''}`,
        ],
        [
          'disks',
          `${formatGib(info.storage.impDiskBytes)} given to imps, of ${formatGib(info.storage.usedBytes + info.storage.availableBytes)}`,
        ],
        ...formatDefaults(info.defaults),
        ...formatEgress(info.egress),
        ...formatKsm(info.ksm),
        ['tailscale', info.tailscale.enabled ? (info.tailscale.state ?? 'enabled') : 'disabled'],
        ...formatTailnetNames(info.tailscale.names),
        ['public', formatPublic(info.public)],
      ];

      for (const [label = '', value = ''] of lines) {
        console.log(`${label.padEnd(12)}${value}`);
      }
    }),
});

// public imps, or why there are none; undefined from an impd before them
function formatPublic(info: SystemInfo['public']): string {
  if (info === undefined) {
    return 'unknown';
  }

  if (info === null) {
    return 'off (IMP_PUBLIC_IP unset)';
  }

  const records = info.records;
  const at = records?.at.toISOString() ?? '';
  let state = 'records not written yet';

  if (records !== null) {
    state = records.isOk
      ? `records ok at ${at}`
      : `records failing at ${at}: ${records.error ?? ''}`;
  }

  return `${String(info.imps)} imps at ${info.ip}, ${state}`;
}

// what sleeping imps take back on a wake; nothing from an impd before it
function formatSleeping(mib: number | undefined): string {
  return mib === undefined ? '' : `, ${String(mib)} asleep`;
}

// what a create gets when it names no memory or image; no line from an
// impd before it
function formatDefaults(defaults: SystemInfo['defaults']): string[][] {
  if (defaults === undefined) {
    return [];
  }

  return [['defaults', `${String(defaults.memoryMib)} MiB, image ${defaults.image ?? '(none)'}`]];
}

function formatEgress(egress: SystemInfo['egress']): string[][] {
  if (egress === undefined) {
    return [];
  }

  return [
    [
      'egress',
      egress.isEnforced ? 'box and none policies enforced' : 'box and none policies not enforced',
    ],
  ];
}

// a line when IMP_KSM is on: what KSM saves and what the governor keeps free for it
function formatKsm(ksm: SystemInfo['ksm']): string[][] {
  if (ksm === null || ksm === undefined) {
    return [];
  }

  const state = ksm.running ? 'merging' : 'ksmd stopped';
  const unmergeable = ksm.unmergeable > 0 ? `, ${String(ksm.unmergeable)} imps unmergeable` : '';

  return [
    [
      'ksm',
      `${state}, ${String(ksm.sharedMib)} MiB shared (profit ${String(ksm.profitMib)} MiB), ${String(ksm.headroomMib)} MiB headroom${unmergeable}`,
    ],
  ];
}

function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

// a line for the per-imp names, then one per name that is not live
function formatTailnetNames(names: SystemInfo['tailscale']['names']): string[][] {
  if (names === null) {
    return [];
  }

  return [
    ['names', `${String(names.live)} live, ${String(names.failed.length)} failed`],
    ...names.failed.map((failure) => ['', `${failure.name}: ${failure.error}`]),
  ];
}
