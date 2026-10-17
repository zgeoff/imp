import { watchEvents } from '@impz/client';
import type { Imp } from '@impz/client';
import { formatBytes } from '@impz/shared';
import { defineCommand } from '../define-command';
import {
  formatCpuUse,
  formatDiskUse,
  formatImp,
  formatOutput,
  formatTable,
} from '../format-output';
import { parseCpuLimit, parseCpuWeight } from '../parse-cpu';
import { parseCount } from '../parse-size';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg, nameArg } from './common-args';

// how often `impz top` asks again when no event comes
const TOP_REFRESH_MS = 2000;

// a burst of events, such as a wake's, re-lists once
const TOP_EVENT_DEBOUNCE_MS = 200;
const HIDE_CURSOR = '\u001B[?25l';
const SHOW_CURSOR = '\u001B[?25h';

// 128 + the signal's number, as a shell reports it
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

export const cpuLimitArg = {
  type: 'string',
  description: 'cores the VM may use, such as 1.5, or none (default none)',
} as const;

export const cpuWeightArg = {
  type: 'string',
  description: 'share of the host under contention, 1 to 10000 (default 100)',
} as const;

interface CpuArgs {
  readonly 'cpu-limit'?: string | undefined;
  readonly 'cpu-weight'?: string | undefined;
}

export function readCpuArgs(args: CpuArgs) {
  return {
    ...(args['cpu-limit'] !== undefined && { cpuLimit: parseCpuLimit(args['cpu-limit']) }),
    ...(args['cpu-weight'] !== undefined && { cpuWeight: parseCpuWeight(args['cpu-weight']) }),
  };
}

export const setCommand = defineCommand({
  name: 'set',
  description:
    "Change an imp's CPU limit or weight (at once when running), its vCPUs (stopped only), or its HTTP port",
  args: {
    name: nameArg,
    'cpu-limit': cpuLimitArg,
    'cpu-weight': cpuWeightArg,
    cpus: { type: 'string', description: 'vCPU count; the imp must be stopped' },
    'http-port': { type: 'string', description: "the port the imp's URL reaches" },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const change = {
        ...readCpuArgs(ctx.values),
        ...(ctx.values.cpus !== undefined && { vcpus: parseCount(ctx.values.cpus, 'cpus') }),
        ...(ctx.values['http-port'] !== undefined && {
          httpPort: parseCount(ctx.values['http-port'], 'http-port'),
        }),
      };

      if (Object.keys(change).length === 0) {
        throw new UsageError('impz set needs --cpu-limit, --cpu-weight, --cpus or --http-port');
      }

      const imp = await client.imps.update({ name: ctx.values.name, ...change });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

// Each imp's use, busiest first: CPU over its limit, the time the limit held
// it back, RAM, disk use over its size, traffic since its VM started, wakes
// and time awake.
export function formatTop(imps: readonly Imp[]): string {
  const sorted = imps.toSorted(
    (a, b) =>
      (b.resources?.sample?.cpuPercent ?? -1) - (a.resources?.sample?.cpuPercent ?? -1) ||
      a.name.localeCompare(b.name),
  );

  return formatTable(
    [
      'NAME',
      'STATE',
      'CPU',
      'WEIGHT',
      'THROTTLED',
      'RAM',
      'DISK',
      'NET IN',
      'NET OUT',
      'WAKES',
      'AWAKE',
    ],
    sorted.map((imp) => {
      const sample = imp.resources?.sample;

      return [
        imp.name,
        imp.state,
        formatCpuUse(imp),
        String(imp.cpu?.weight ?? '-'),
        sample === undefined ? '-' : formatSeconds(sample.cpuThrottledMs),
        imp.ramMib === undefined ? '-' : `${String(imp.ramMib)} MiB`,
        formatDiskUse(imp),
        sample === undefined ? '-' : formatBytes(sample.netRxBytes),
        sample === undefined ? '-' : formatBytes(sample.netTxBytes),
        String(imp.resources?.wakeCount ?? '-'),
        imp.resources === undefined ? '-' : formatSeconds(imp.resources.awakeMs),
      ];
    }),
  );
}

export const topCommand = defineCommand({
  name: 'top',
  description: "Watch every imp's CPU, memory and traffic",
  args: {
    once: { type: 'boolean', description: 'print the table once and exit' },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imps = await client.imps.list();

      if (ctx.values.once === true || ctx.values.json === true) {
        ctx.extensions.impz.io.print(formatOutput(imps, ctx.values.json, formatTop));

        return;
      }

      // an event refreshes soon; the clock catches what moves without one
      const refresh = { wake: (): void => {} };

      // the cursor comes back however top ends
      for (const [signal, code] of Object.entries(SIGNAL_EXIT_CODES)) {
        process.once(signal, () => {
          process.stdout.write(`${SHOW_CURSOR}\n`);
          process.exit(code);
        });
      }

      process.stdout.write(HIDE_CURSOR);

      const watchRefreshes = async (): Promise<void> => {
        try {
          await watchEvents(client, {
            onEvent: (event) => {
              if (event.ev !== 'ImpAdded' || event.reason !== 'snapshot') {
                refresh.wake();
              }
            },
          });
        } catch {
          // the clock still refreshes
        }
      };

      void watchRefreshes();

      for (let listed = imps; ; listed = await client.imps.list()) {
        process.stdout.write(`\u001B[H\u001B[2J${formatTop(listed)}\n`);

        const waiting = Promise.withResolvers<undefined>();

        const timer = setTimeout(() => {
          waiting.resolve(undefined);
        }, TOP_REFRESH_MS);

        refresh.wake = () => {
          setTimeout(() => {
            waiting.resolve(undefined);
          }, TOP_EVENT_DEBOUNCE_MS);
        };

        await waiting.promise;

        clearTimeout(timer);
      }
    }),
});

function formatSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000);

  if (seconds < 120) {
    return `${String(seconds)}s`;
  }

  const minutes = Math.round(seconds / 60);

  return minutes < 120 ? `${String(minutes)}m` : `${String(Math.round(minutes / 60))}h`;
}
