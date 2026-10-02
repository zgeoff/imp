import { isImpAllowed } from '@imp/api';
import type { EgressMode, Identity, SystemInfo } from '@imp/api';
import { ORPCError } from '@orpc/client';
import type { ImpClient } from './create-imp-client';
import type { HostAnswer } from './fan-out';

// what `imp new --place` asks of a host
export interface PlaceRequest {
  readonly name: string | null;
  readonly image: string | null;
  readonly memoryMib: number | null;
  readonly cpuLimit: number | null;
  readonly policyMode: EgressMode | null;
  readonly networks: readonly string[];

  // --public and --net need a manage token with no imp patterns
  readonly needsWholeHost: boolean;
}

// what placement reads from one host before it picks
export interface HostProbe {
  readonly info: SystemInfo;
  readonly identity: Identity;
  readonly images: readonly string[];
  readonly imps: readonly string[];
  readonly networks: readonly string[];
}

export interface RankedHost {
  readonly host: string;
  readonly freeMib: number;
}

interface DroppedHost {
  readonly host: string;
  readonly reason: string;
}

export interface Ranking {
  // best first
  readonly ranked: readonly RankedHost[];
  readonly dropped: readonly DroppedHost[];
}

// One host's facts, in one round of calls under the fan-out's signal. The
// image, imp and network lists are names only: each is local to its host.
export async function readHostProbe(
  client: ImpClient,
  signal: AbortSignal,
  request: PlaceRequest,
): Promise<HostProbe> {
  const options = { signal };

  const [info, identity, images, imps, networks] = await Promise.all([
    client.system.info(undefined, options),
    client.tokens.whoami(undefined, options),
    client.images.list(undefined, options),
    client.imps.list(undefined, options),
    request.networks.length === 0 ? [] : client.networks.list(undefined, options),
  ]);

  return {
    info,
    identity,
    images: images.map((image) => image.name),
    imps: imps.map((imp) => imp.name),
    networks: networks.map((network) => network.name),
  };
}

// Drops each host that would refuse the create, then ranks the rest by free
// RAM. A name taken on a host that answered ends it: best effort, as a host
// out of reach or a token's imp patterns hide names.
export function buildRanking(
  answers: readonly HostAnswer<HostProbe>[],
  request: PlaceRequest,
): Ranking {
  const ranked: RankedHost[] = [];
  const dropped: DroppedHost[] = [];

  for (const answer of answers) {
    if ('error' in answer) {
      dropped.push({ host: answer.host, reason: answer.error });
      continue;
    }

    if (request.name !== null && answer.value.imps.includes(request.name)) {
      throw new Error(`${request.name} exists on ${answer.host} already; pick another name`);
    }

    const reason = findRefusal(answer.value, request);

    if (reason === null) {
      ranked.push({ host: answer.host, freeMib: readFreeMib(answer.value.info) });
    } else {
      dropped.push({ host: answer.host, reason });
    }
  }

  // a stable sort: a tie goes to the host first in name order
  return { ranked: ranked.toSorted((first, second) => second.freeMib - first.freeMib), dropped };
}

// The budget less what awake VMs own, boots under way reserve, and every
// sleeper takes back on a wake; idle imps the governor could sleep are not
// counted, so it errs low (docs/guides/hosts.md#placement)
export function readFreeMib(info: SystemInfo): number {
  return info.ramBudgetMib - info.ramUsedMib - info.ramReservedMib - (info.ramSleepingMib ?? 0);
}

// The next host only when the governor turned the boot away, as impd then
// removes the imp before it answers; any other failure, a timeout too, may
// leave an imp, so it ends placement
export async function createPlaced<T>(
  ranked: readonly RankedHost[],
  create: (host: string) => Promise<T>,
  onRefusal: (host: string, message: string) => void,
): Promise<{ readonly host: string; readonly value: T }> {
  for (const candidate of ranked) {
    const host = candidate.host;

    try {
      return { host, value: await create(host) };
    } catch (error) {
      if (!(error instanceof ORPCError) || error.code !== 'RAM_BUDGET_EXCEEDED') {
        throw error;
      }

      onRefusal(host, error.message);
    }
  }

  throw new Error('every host that could take the imp turned it away for RAM');
}

function findRefusal(probe: HostProbe, request: PlaceRequest): string | null {
  const info = probe.info;

  if (info.defaults === undefined || info.egress === undefined) {
    return `impd ${info.version} is too old to place on; upgrade it or use --host`;
  }

  return (
    findTokenRefusal(probe.identity, request) ??
    findRamRefusal(info.ramBudgetMib, request.memoryMib ?? info.defaults.memoryMib) ??
    (info.storage.isLow ? 'its storage is low' : null) ??
    findCpuRefusal(info.cpu?.hostCpus, request.cpuLimit) ??
    findImageRefusal(probe.images, request.image ?? info.defaults.image) ??
    findPolicyRefusal(info.egress.isEnforced, request.policyMode) ??
    findNetworkRefusal(probe.networks, request.networks)
  );
}

function findTokenRefusal(identity: Identity, request: PlaceRequest): string | null {
  if (identity.scope !== 'manage') {
    return `its token has ${identity.scope} scope, not manage`;
  }

  if (identity.imps === null) {
    return null;
  }

  if (request.needsWholeHost) {
    return 'its token is limited to some imps, which --public and --net need it not to be';
  }

  // impd refuses an unnamed create from a limited token
  if (request.name === null) {
    return 'its token is limited to some imps, so the imp needs a name';
  }

  return isImpAllowed(identity.imps, request.name)
    ? null
    : `its token may not touch ${request.name} (${identity.imps.join(', ')})`;
}

// the governor never admits more memory than the whole budget
function findRamRefusal(budgetMib: number, memoryMib: number): string | null {
  return budgetMib < memoryMib
    ? `its RAM budget of ${String(budgetMib)} MiB is below ${String(memoryMib)} MiB`
    : null;
}

function findCpuRefusal(hostCpus: number | undefined, limit: number | null): string | null {
  return hostCpus !== undefined && limit !== null && limit > hostCpus
    ? `it has ${String(hostCpus)} cores, fewer than the CPU limit`
    : null;
}

function findImageRefusal(images: readonly string[], image: string | null): string | null {
  if (image === null) {
    return 'it has no default image; name one with --image';
  }

  return images.includes(image) ? null : `it has no image ${image}`;
}

function findPolicyRefusal(isEnforced: boolean, mode: EgressMode | null): string | null {
  return mode === null || mode === 'open' || isEnforced
    ? null
    : `it cannot enforce a ${mode} egress policy`;
}

function findNetworkRefusal(networks: readonly string[], wanted: readonly string[]): string | null {
  const missing = wanted.filter((network) => !networks.includes(network));

  return missing.length === 0 ? null : `it has no network ${missing.join(', ')}`;
}
