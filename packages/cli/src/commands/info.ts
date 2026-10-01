import { defineCommand } from 'citty';
import { runAction } from '../run-action';

export const infoCommand = defineCommand({
  meta: { name: 'info', description: 'Show impd version, RAM budget and counts' },
  run: () =>
    runAction(async (client) => {
      const info = await client.system.info();

      const lines = [
        ['version', info.version],
        ['imps', `${String(info.impCount)} (${String(info.awakeCount)} awake)`],
        ['ram', `${String(info.ramUsedMib)} / ${String(info.ramBudgetMib)} MiB`],
        ['firecracker', info.firecrackerVersion ?? 'unknown'],
        ['tailscale', info.tailscale.enabled ? (info.tailscale.state ?? 'enabled') : 'disabled'],
      ];

      for (const [label = '', value = ''] of lines) {
        console.log(`${label.padEnd(12)}${value}`);
      }
    }),
});
