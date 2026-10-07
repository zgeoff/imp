import * as dnsPacket from 'dns-packet';
import type { NetworkMember } from '../db/networks';
import type { QueryVerdict, ResolverDeps } from '../egress/egress-resolver';
import type { AddressAnswer } from '../egress/egress-sets';
import { resolveNetworkName } from '../egress/network-names';
import { parseSubnet } from '../net/addressing';
import { buildMockDnsReply } from './build-mock-dns-message';
import type { MockDnsRecord } from './build-mock-dns-message';

interface StubEgressServiceOptions {
  // IMP_SUBNET; 10.66.0.0/16 by default
  readonly subnet?: string;

  // each slot that holds an imp, with the verdict on each name it may ask
  // for: a name it does not list is refused, and a slot it does not list
  // holds no imp
  readonly verdicts?: Readonly<Record<number, Readonly<Record<string, QueryVerdict>>>>;

  // the records the upstream answers each name with; none for the rest
  readonly upstream?: Readonly<Record<string, readonly MockDnsRecord[]>>;

  // the networks impd knows, and their members
  readonly networks?: readonly string[];
  readonly members?: readonly NetworkMember[];

  // the addresses a public imp may not reach
  readonly screened?: readonly string[];
}

interface AdmittedAnswer {
  readonly slot: number;
  readonly names: readonly string[];
  readonly answers: readonly AddressAnswer[];
}

// The egress service as its resolver sees it (createQueryHandler's deps):
// the test's verdicts and upstream records, recorded set writes and
// forwards, and a clock that moves only with `advance`.
export function buildStubEgressService(options: Readonly<StubEgressServiceOptions> = {}) {
  const subnet = parseSubnet(options.subnet ?? '10.66.0.0/16');
  const verdicts = options.verdicts ?? {};
  const upstream = options.upstream ?? {};

  const screened = new Set(options.screened);

  const view = { names: new Set(options.networks), members: options.members ?? [] };
  const admitted: AdmittedAnswer[] = [];
  const forwarded: string[] = [];
  const logs: string[] = [];
  const clock = { nowMs: 0 };

  const deps: ResolverDeps = {
    subnet,
    resolveLocal: (slot, query) => resolveNetworkName(view, subnet, { slot, ...query }),
    checkName: (slot, name) => {
      const slotVerdicts = verdicts[slot];
      const verdict = slotVerdicts === undefined ? null : (slotVerdicts[name] ?? 'refuse');

      return Promise.resolve(verdict);
    },
    writeAnswers: (slot, names, answers) => {
      admitted.push({ slot, names, answers });

      return Promise.resolve();
    },
    forward: (query) => {
      const name = dnsPacket.decode(Buffer.from(query)).questions?.[0]?.name ?? '';

      forwarded.push(name);

      // names are case-insensitive upstream as in DNS
      const answers = upstream[name.toLowerCase()] ?? [];

      return Promise.resolve(buildMockDnsReply(query, { answers }));
    },
    isScreened: (address) => screened.has(address),
    maxTtlS: 86_400,
    readRate: () => ({ burst: 100, perSecond: 10 }),
    now: () => clock.nowMs,
    log: (message) => {
      logs.push(message);
    },
  };

  return {
    deps,
    admitted: admitted as readonly AdmittedAnswer[],
    forwarded: forwarded as readonly string[],
    logs: logs as readonly string[],
    advance: (ms: number): void => {
      clock.nowMs += ms;
    },
  };
}
