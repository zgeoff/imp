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
          `${String(info.ramUsedMib)} / ${String(info.ramBudgetMib)} MiB (${String(info.ramReservedMib)} reserved, ${String(info.ramCommittedMib)} committed)`,
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
        ['tailscale', info.tailscale.enabled ? (info.tailscale.state ?? 'enabled') : 'disabled'],
        ...formatTailnetNames(info.tailscale.names),
      ];

      for (const [label = '', value = ''] of lines) {
        console.log(`${label.padEnd(12)}${value}`);
      }
    }),
});

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
