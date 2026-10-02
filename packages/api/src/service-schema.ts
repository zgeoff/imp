import * as z from 'zod';
import { ImpStateSchema } from './imp-schema';

// A service's name is its file name in /etc/imp/services.d and in
// /var/log/imp. The agent checks the same rule (agent/internal/services).
export const ServiceNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    'must be a lowercase letter or digit followed by up to 62 lowercase letters, digits or -',
  );

export const ServiceRestartSchema = z.enum(['always', 'on-failure', 'never']);
const EnvEntrySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*=/, 'must be KEY=VALUE');

// one /etc/imp/services.d file (docs/guides/services.md)
export const ServiceDefSchema = z.object({
  name: ServiceNameSchema,
  argv: z.array(z.string().min(1)).min(1).max(256).readonly(),
  env: z.array(EnvEntrySchema).max(256).readonly().optional(),
  cwd: z.string().min(1).optional(),
  user: z.string().min(1).optional(),
  restart: ServiceRestartSchema.optional(),
});

export const ServiceStateSchema = z.enum(['starting', 'running', 'backoff', 'stopped', 'exited']);

export const ServiceSchema = z.object({
  name: z.string(),
  state: ServiceStateSchema,
  pid: z.int().positive().nullable(),

  // restarts after an exit since the service started; a restart call starts
  // the count again
  restarts: z.int().nonnegative(),

  // the last run's end; signal is null for a normal exit
  lastExit: z.object({ code: z.int(), signal: z.string().nullable() }).nullable(),
  argv: z.array(z.string()).readonly(),

  // the env's keys only: a value can hold a secret
  envKeys: z.array(z.string()).readonly(),
  cwd: z.string().nullable(),
  user: z.string().nullable(),
  restart: ServiceRestartSchema,

  // `api` for a service `services.add` wrote, `image` for one the image
  // shipped or a file written by hand
  source: z.enum(['image', 'api']),

  // it runs as uid 0, or as a user the guest cannot resolve: removing or
  // restarting it needs the manage scope
  root: z.boolean(),
});

// What `services.logs` sends (docs/guides/services.md#logs)
export const ServiceLogSchema = z.discriminatedUnion('type', [
  // a piece of a service's log as the guest sent it; it may end mid-line
  z.object({ type: z.literal('log'), service: z.string(), text: z.string() }),

  // a follow only: the imp stopped running, it runs again and the logs go
  // on, and impd is restarting, the last event
  z.object({ type: z.literal('sleeping'), state: ImpStateSchema }),
  z.object({ type: z.literal('awake') }),
  z.object({ type: z.literal('restarting') }),
]);

export type ServiceDef = z.infer<typeof ServiceDefSchema>;

export type Service = z.infer<typeof ServiceSchema>;

// What services.list answers. A running imp's agent lists its services; a
// sleeping imp's come from what its last sleep recorded, and `recorded` is
// false when that sleep recorded none, so an empty list is not news.
export const ServiceListSchema = z.object({
  services: z.array(ServiceSchema).readonly(),
  recorded: z.boolean(),
});

export type ServiceList = z.infer<typeof ServiceListSchema>;

export type ServiceLog = z.infer<typeof ServiceLogSchema>;
