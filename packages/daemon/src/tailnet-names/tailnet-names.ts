import { listImps } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { createSemaphore } from '../imps/semaphore';
import { readErrorMessage } from '../read-error-message';
import { listServeEntries } from './service-serve';
import type { ServedServices, ServiceServe } from './service-serve';
import type { ServiceDefinition, ServicesApi, TailnetService } from './services-api';
import type { TailnetNamesConfig } from './tailnet-names-config';

// the tag every service impd makes carries; the tailnet policy lets tag:imp
// hosts serve it and members reach it (docs/guides/tailscale.md)
export const SERVICE_TAG = 'tag:imp-svc';
const SERVICE_PORTS = ['tcp:80', 'tcp:443'];

interface TailnetNameFailure {
  readonly name: string;
  readonly error: string;
}

export interface TailnetNamesStatus {
  readonly live: number;
  readonly failed: readonly TailnetNameFailure[];
}

// Each imp's own name on the tailnet, as a Tailscale Service this host
// serves (docs/guides/tailscale.md#per-imp-names).
export interface TailnetNames {
  // one pass at a time: claims the imps' services, serves them, and removes
  // this host's services that no imp has any more
  readonly runSync: () => Promise<void>;

  // https://<service>.<tailnet>, once the name is live
  readonly readUrl: (impName: string) => string | null;
  readonly readStatus: () => TailnetNamesStatus;
}

export interface TailnetNamesDeps {
  readonly config: TailnetNamesConfig;
  readonly hostId: string;
  readonly db: ImpDatabase;
  readonly api: ServicesApi;
  readonly serve: ServiceServe;

  // the imp's own port, which wakes it
  readonly findPort: (slot: number) => number;

  // false once no imp has the name; true holds the imp's lock while it says so
  readonly isImpPresent: (name: string) => Promise<boolean>;

  // the tailnet's MagicDNS suffix, such as tail1234.ts.net
  readonly readSuffix: () => Promise<string | null>;
  readonly log: (message: string) => void;
}

type NameState = { readonly live: true } | { readonly live: false; readonly error: string };

export function createTailnetNames(deps: TailnetNamesDeps): TailnetNames {
  const owner = `imp host ${deps.hostId}`;

  const states = new Map<string, NameState>();

  const pass = createSemaphore(1);
  const view: { suffix: string | null } = { suffix: null };
  const toService = (impName: string): string => `svc:${deps.config.prefix}${impName}`;

  const isOurs = (service: TailnetService): boolean =>
    (service.tags ?? []).includes(SERVICE_TAG) && service.comment === owner;

  // a failure is logged when it starts or changes, not on every pass
  const writeState = (impName: string, next: NameState): void => {
    const last = states.get(impName);

    if (!next.live && (last === undefined || last.live || last.error !== next.error)) {
      deps.log(`impd: tailnet names: ${impName}: ${next.error}`);
    }

    if (next.live && last?.live !== true) {
      deps.log(`impd: tailnet names: ${impName} is ${toService(impName)}`);
    }

    states.set(impName, next);
  };

  // A fresh read before any write: a service by this name that is not this
  // host's (another team's, or a second imp host's) is never overwritten.
  const claimService = async (service: string, listed: TailnetService | undefined) => {
    if (listed !== undefined && !isOurs(listed)) {
      throw new Error(`${service} exists and this host does not own it`);
    }

    const definition: ServiceDefinition = {
      name: service,
      comment: owner,
      ports: SERVICE_PORTS,
      tags: [SERVICE_TAG],
    };

    if (listed !== undefined && isSameDefinition(listed, definition)) {
      return;
    }

    // The API has no conditional write, so a service someone makes between
    // this read and the PUT is overwritten; the read narrows that to the
    // time one request takes.
    const current = await deps.api.readService(service);

    if (current !== null && !isOurs(current)) {
      throw new Error(`${service} exists and this host does not own it`);
    }

    await deps.api.writeService(definition);
  };

  // Serve config, then the definition, and only for a name no imp has. No
  // drain first: the imp is gone, so no connection through it is left to
  // finish.
  const removeService = async (service: string, isServed: boolean) => {
    const impName = service.slice(`svc:${deps.config.prefix}`.length);

    const present = await deps.isImpPresent(impName);

    if (present) {
      return;
    }

    if (isServed) {
      await deps.serve.clearServe(service);
    }

    await deps.api.deleteService(service);

    deps.log(`impd: tailnet names: removed ${service}, which no imp has`);
  };

  const runPass = async (): Promise<void> => {
    view.suffix = await deps.readSuffix();

    // a moving imp's name is the source's until the target commits, and no
    // pass refreshes it meanwhile (docs/guides/hosts.md#moves); an image
    // builder serves nothing
    const listed = await listImps(deps.db);

    const imps = listed.filter((imp) => imp.moveState === null && imp.kind === 'user');

    const wanted = new Map(imps.map((imp) => [toService(imp.name), imp]));

    for (const name of states.keys()) {
      if (!wanted.has(toService(name))) {
        states.delete(name);
      }
    }

    let services: readonly TailnetService[];
    let served: ServedServices;

    try {
      services = await deps.api.listServices();
      served = await deps.serve.readServed();
    } catch (error) {
      for (const imp of imps) {
        writeState(imp.name, { live: false, error: readErrorMessage(error) });
      }

      return;
    }

    const byName = new Map(services.map((service) => [service.name, service]));

    for (const [service, imp] of wanted) {
      try {
        await claimService(service, byName.get(service));

        const target = `http://127.0.0.1:${String(deps.findPort(imp.slot))}`;

        if (!isSameEntries(served.get(service) ?? [], listServeEntries(target))) {
          await deps.serve.writeServe(service, target);
        }

        writeState(imp.name, { live: true });
      } catch (error) {
        writeState(imp.name, { live: false, error: readErrorMessage(error) });
      }
    }

    // this host's services no imp has, and serve config for a service
    // that is gone from the tailnet
    for (const service of services) {
      if (isOurs(service) && !wanted.has(service.name)) {
        await tryRemove(service.name, () => removeService(service.name, served.has(service.name)));
      }
    }

    for (const service of served.keys()) {
      if (!wanted.has(service) && !byName.has(service)) {
        await tryRemove(service, () => deps.serve.clearServe(service));
      }
    }
  };

  const tryRemove = async (service: string, remove: () => Promise<void>): Promise<void> => {
    try {
      await remove();
    } catch (error) {
      deps.log(`impd: tailnet names: removing ${service}: ${readErrorMessage(error)}`);
    }
  };

  return {
    runSync: () => pass.run(runPass),
    readUrl: (impName) =>
      states.get(impName)?.live === true && view.suffix !== null
        ? `https://${deps.config.prefix}${impName}.${view.suffix}`
        : null,
    readStatus: () => {
      const failed: TailnetNameFailure[] = [];
      let live = 0;

      for (const [name, state] of states) {
        if (state.live) {
          live += 1;
        } else {
          failed.push({ name, error: state.error });
        }
      }

      return { live, failed };
    },
  };
}

function isSameDefinition(service: TailnetService, definition: ServiceDefinition): boolean {
  return isSameEntries(service.ports ?? [], definition.ports);
}

function isSameEntries(have: readonly string[], want: readonly string[]): boolean {
  return have.length === want.length && want.every((entry) => have.includes(entry));
}
