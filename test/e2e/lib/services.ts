import * as z from 'zod';
import { runImp } from './imp-cli';
import { waitFor } from './wait-for';

const ServiceRowSchema = z.object({
  name: z.string(),
  state: z.string(),
  pid: z.int().nullable(),
  argv: z.array(z.string()),
  envKeys: z.array(z.string()),
  source: z.string(),
  root: z.boolean(),
});

export type ServiceRow = z.infer<typeof ServiceRowSchema>;

// `imp service ls <imp> --json`, with the fields the suites read
export function parseServices(stdout: string): ServiceRow[] {
  return z.array(ServiceRowSchema).parse(JSON.parse(stdout));
}

export async function listServices(imp: string): Promise<ServiceRow[]> {
  const stdout = await runImp('service', 'ls', imp, '--json');

  return parseServices(stdout);
}

// waits until the service runs with a pid other than `other`, and returns it
export function waitForServicePid(
  imp: string,
  service: string,
  other: number | null,
): Promise<number> {
  return waitFor(`the ${service} service to run`, async () => {
    const services = await listServices(imp);

    const found = services.find((row) => row.name === service);

    if (found?.state !== 'running' || found.pid === null || found.pid === other) {
      throw new Error(`${service}: ${JSON.stringify(found)}`);
    }

    return found.pid;
  });
}
