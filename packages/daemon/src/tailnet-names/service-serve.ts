import * as z from 'zod';
import { runChecked } from '../process/run-command';

const HandlerSchema = z.object({ Proxy: z.string().optional() });

const WebSchema = z.object({
  Handlers: z.record(z.string(), HandlerSchema).nullable().optional(),
});

const ServiceConfigSchema = z.object({
  Web: z.record(z.string(), WebSchema).nullable().optional(),
});

const ServeStatusSchema = z.object({
  Services: z.record(z.string(), ServiceConfigSchema).nullable().optional(),
});

// each service this node serves, as `<port> <proxy target>` per root handler
export type ServedServices = ReadonlyMap<string, readonly string[]>;

// `tailscale serve` for Tailscale Services on this node
export interface ServiceServe {
  readonly readServed: () => Promise<ServedServices>;

  // plain HTTP on 80 and HTTPS on 443, both to the target
  readonly writeServe: (service: string, target: string) => Promise<void>;

  // no new connections, then no config: the order a removal takes
  readonly drainServe: (service: string) => Promise<void>;
  readonly clearServe: (service: string) => Promise<void>;
}

// From `tailscale serve status --json`. Output it cannot read serves nothing.
export function parseServedServices(json: string): ServedServices {
  try {
    const text = json.trim() === '' ? '{}' : json;
    const status = ServeStatusSchema.parse(JSON.parse(text));

    return new Map(
      Object.entries(status.Services ?? {}).map(([name, config]) => [
        name,
        Object.entries(config.Web ?? {}).flatMap(([hostPort, web]) => {
          const proxy = web.Handlers?.['/']?.Proxy;
          const port = hostPort.split(':').at(-1) ?? '';

          return proxy === undefined ? [] : [`${port} ${proxy}`];
        }),
      ]),
    );
  } catch {
    return new Map();
  }
}

// what writeServe leaves for a service and its target
export function listServeEntries(target: string): readonly string[] {
  return [`443 ${target}`, `80 ${target}`];
}

// --service implies --bg: the config persists in tailscaled's state
export function createServiceServe(
  run: (argv: readonly string[]) => Promise<string> = runChecked,
): ServiceServe {
  return {
    readServed: async () => {
      const json = await run(['tailscale', 'serve', 'status', '--json']);

      return parseServedServices(json);
    },
    writeServe: async (service, target) => {
      await run(['tailscale', 'serve', `--service=${service}`, '--http=80', target]);
      await run(['tailscale', 'serve', `--service=${service}`, '--https=443', target]);
    },
    drainServe: async (service) => {
      await run(['tailscale', 'serve', 'drain', service]);
    },
    clearServe: async (service) => {
      await run(['tailscale', 'serve', 'clear', service]);
    },
  };
}
