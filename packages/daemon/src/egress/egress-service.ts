import { Resolver } from 'node:dns/promises';
import type { EgressPolicy } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildNotFoundError } from '../api-errors';
import { REFUSED_RANGES } from '../broker/tunnel-target';
import type { Config } from '../config';
import { listEgressSlots, readEgressPolicy, writeEgressPolicy } from '../db/egress';
import type { EgressSlot } from '../db/egress';
import { findImpByName } from '../db/imps';
import { listNetworkMembers } from '../db/networks';
import type { NetworkMember } from '../db/networks';
import type { ImpDatabase } from '../db/open-database';
import { createKeyedMutex } from '../imps/keyed-mutex';
import { formatSubnet, parseIpv4 } from '../net/addressing';
import { deriveGuestIp6 } from '../net/addressing6';
import { readConnectedPrefixes6 } from '../net/ipv6-plan';
import type { Ipv6Plan } from '../net/ipv6-plan';
import { BLOCKED_RANGES6 } from '../net/ranges6';
import { runCommand } from '../process/run-command';
import { readErrorMessage } from '../read-error-message';
import { createDnsForward } from './dns-upstream';
import type { DnsForward } from './dns-upstream';
import { createNftWriter, formatNftError, runNft } from './egress-firewall';
import type { NftRunner } from './egress-firewall';
import { createQueryHandler, startResolverServer } from './egress-resolver';
import type { QueryVerdict, ResolverServer } from './egress-resolver';
import { buildAllowRules, isNameAllowed, isTunnelAllowed, listExactNames } from './egress-rules';
import type { AllowRules } from './egress-rules';
import { buildElementChange, buildRuleset } from './egress-ruleset';
import type { NetworkPeer } from './egress-ruleset';
import { createEgressSets } from './egress-sets';
import type { AddressAnswer } from './egress-sets';

// impd's clamp on an answer's TTL, and the size of a box imp's set
const MIN_TTL_S = 300;
const MAX_TTL_S = 86_400;
const SET_SIZE = 4096;
const SWEEP_MS = 30_000;

// a box imp's queries: a burst, then this many a second
const QUERY_BURST = 500;
const QUERIES_PER_SECOND = 100;

export interface EgressDeps {
  readonly config: Pick<Config, 'subnet' | 'dns' | 'egressDnsPort'>;
  readonly db: ImpDatabase;
  readonly log: (message: string) => void;

  // the broker: hosts a grant covers, and its plain tunnels
  readonly isGranted: (impId: string, host: string) => Promise<boolean>;
  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;

  // the IPv6 impd resolved at start; null or left out, imps get none
  readonly ipv6?: Ipv6Plan | null;

  // tests stand in for nft, conntrack and the network
  readonly runNft?: NftRunner;
  readonly readConnected6?: () => Promise<readonly string[]>;
  readonly flushConnections?: (guestIp: string) => Promise<void>;
  readonly forward?: DnsForward;
  readonly resolveExact?: (name: string) => Promise<readonly AddressAnswer[]>;
  readonly now?: () => number;
}

export interface EgressService {
  // the table, then the resolver: before any VM is adopted, booted or woken
  readonly start: () => Promise<void>;
  readonly stop: () => void;

  // PRECONDITION_FAILED for a box or none policy when nft cannot enforce it
  readonly requirePolicy: (policy: EgressPolicy) => void;
  readonly requireImp: (impId: string) => Promise<void>;

  // a new imp's slot, fresh, after its insert and before its tap
  readonly addSlot: (slot: number) => Promise<void>;

  // a destroyed imp's slot, out of the table before the slot is free
  readonly releaseSlot: (slot: number) => Promise<void>;
  readonly readPolicy: (name: string) => Promise<EgressPolicy>;
  readonly setPolicy: (name: string, policy: EgressPolicy) => Promise<EgressPolicy>;

  // the resolver's side: its verdict on a name, the answers it lets in,
  // and the sweep of what expired
  readonly checkName: (slot: number, name: string) => Promise<QueryVerdict | null>;
  readonly writeAnswers: (
    slot: number,
    names: readonly string[],
    answers: readonly AddressAnswer[],
  ) => Promise<void>;
  readonly runSweep: () => Promise<void>;
}

interface SlotView {
  readonly entry: EgressSlot;
  readonly rules: AllowRules;
}

export function createEgressService(deps: EgressDeps): EgressService {
  const now = deps.now ?? Date.now;
  const write = createNftWriter(deps.runNft ?? runNft);
  const flushConnections = deps.flushConnections ?? runConntrackFlush;
  const forward = deps.forward ?? createDnsForward(deps.config.dns);
  const ipv6 = deps.ipv6 ?? null;
  const readConnected6 = deps.readConnected6 ?? readConnectedPrefixes6;
  const resolveExact = deps.resolveExact ?? createExactResolver(deps.config.dns, ipv6 !== null);
  const sets = createEgressSets({ minTtlS: MIN_TTL_S, maxTtlS: MAX_TTL_S, maxPerSlot: SET_SIZE });
  const mutex = createKeyedMutex();

  const privateRanges = [
    ...REFUSED_RANGES.map(([network, prefix]) => `${network}/${String(prefix)}`),
    formatSubnet(deps.config.subnet),
  ];

  const state: {
    slots: Map<number, SlotView>;

    // the networks' members, released slots left out
    members: readonly NetworkMember[];
    released: Set<number>;
    unenforced: string | null;
    server: ResolverServer | null;
    sweep: Timer | null;
  } = {
    slots: new Map(),
    members: [],
    released: new Set(),
    unenforced: null,
    server: null,
    sweep: null,
  };

  // an imp's /128, from its IPv4 address as its tap derives it
  const findGuestIp6 = (guestIp: string): string | null => {
    const ip = parseIpv4(guestIp);

    return ipv6 === null || ip === null ? null : deriveGuestIp6(ipv6.prefix, ip);
  };

  const buildScript = (
    views: ReadonlyMap<number, SlotView>,
    connected6: readonly string[],
    members: readonly NetworkMember[],
  ): string =>
    buildRuleset({
      networks: listPeerGroups(members),
      subnet: formatSubnet(deps.config.subnet),
      dnsServers: deps.config.dns,
      privateRanges,
      blocked6: [...BLOCKED_RANGES6, ...(ipv6 === null ? [] : [ipv6.prefix.text]), ...connected6],
      dnsPort: deps.config.egressDnsPort,
      setSize: SET_SIZE,
      slots: [...views.values()].map((view) => ({
        slot: view.entry.slot,
        tap: `imp${String(view.entry.slot)}`,
        guestIp: view.entry.guestIp,
        guestIp6: findGuestIp6(view.entry.guestIp),
        mode: view.entry.policy.mode,
        cidrs: view.entry.policy.mode === 'box' ? view.rules.cidrs : [],
        addresses: view.entry.policy.mode === 'box' ? sets.listAddresses(view.entry.slot) : [],
      })),
    });

  // the slots from the database, then the whole table in one transaction;
  // impd's view of the slots changes only once nft has taken it
  const applyTable = (): Promise<void> =>
    mutex.runExclusive('table', async () => {
      const rows = await listEgressSlots(deps.db);

      const slots = new Map<number, SlotView>();

      for (const entry of rows) {
        if (!state.released.has(entry.slot)) {
          slots.set(entry.slot, { entry, rules: buildAllowRules(entry.policy.allow) });
        }
      }

      const allMembers = await listNetworkMembers(deps.db);

      const members = allMembers.filter((member) => slots.has(member.slot));

      if (state.unenforced === null) {
        // the container's own links, read now: a network can join it later
        const connected6 = ipv6 === null ? [] : await readConnected6();

        await write(buildScript(slots, connected6, members));
      }

      for (const slot of state.slots.keys()) {
        if (!slots.has(slot)) {
          sets.clear(slot);
        }
      }

      state.slots = slots;
      state.members = members;
    });

  // after a failed apply: nft may still refuse, and keeps its last table
  const tryApplyTable = async (): Promise<void> => {
    try {
      await applyTable();
    } catch (error) {
      deps.log(`impd: egress: rebuilding the table: ${readErrorMessage(error)}`);
    }
  };

  const writeAnswers = async (
    slot: number,
    names: readonly string[],
    answers: readonly AddressAnswer[],
  ): Promise<void> => {
    if (state.slots.get(slot)?.entry.policy.mode !== 'box') {
      return;
    }

    const change = sets.record(slot, names, answers, now());

    const script =
      (change.removed.length > 0 ? buildElementChange('delete', slot, change.removed) : '') +
      (change.added.length > 0 ? buildElementChange('add', slot, change.added) : '');

    if (script !== '') {
      await write(script);
    }
  };

  const checkName = async (slot: number, name: string): Promise<QueryVerdict | null> => {
    const view = state.slots.get(slot);

    if (view === undefined || view.entry.policy.mode === 'open') {
      return null;
    }

    if (
      view.entry.policy.mode === 'box' &&
      (isNameAllowed(view.rules, name) || sets.isAlias(slot, name, now()))
    ) {
      return 'admit';
    }

    const granted = await deps.isGranted(view.entry.impId, name);

    return granted ? 'answer' : 'refuse';
  };

  // the exact names of a box's list, resolved before the guest asks
  const resolveExactNames = async (slot: number): Promise<void> => {
    const view = state.slots.get(slot);

    if (view?.entry.policy.mode !== 'box') {
      return;
    }

    for (const name of listExactNames(view.entry.policy.allow)) {
      try {
        const answers = await resolveExact(name);

        await writeAnswers(slot, [name], answers);
      } catch (error) {
        deps.log(`impd: egress: ${view.entry.name}: resolving ${name}: ${readErrorMessage(error)}`);
      }
    }
  };

  const runSweep = async (): Promise<void> => {
    const due = sets.sweep(now());

    const scripts = [...due].flatMap(([slot, addresses]) =>
      state.slots.get(slot)?.entry.policy.mode === 'box'
        ? [buildElementChange('delete', slot, addresses)]
        : [],
    );

    if (scripts.length > 0) {
      await write(scripts.join(''));
    }
  };

  const runLoggedSweep = async (): Promise<void> => {
    try {
      await runSweep();
    } catch (error) {
      deps.log(`impd: egress: sweep: ${readErrorMessage(error)}`);
    }
  };

  const requirePolicy = (policy: EgressPolicy): void => {
    if (policy.mode !== 'open' && state.unenforced !== null) {
      throw new ORPCError('PRECONDITION_FAILED', {
        message: `impd cannot enforce a ${policy.mode} egress policy here: ${state.unenforced}`,
      });
    }
  };

  return {
    start: async () => {
      try {
        await applyTable();
      } catch (error) {
        state.unenforced = formatNftError(error);

        await applyTable();

        const closed = [...state.slots.values()].filter(
          (view) => view.entry.policy.mode !== 'open',
        );

        deps.log(
          `impd: egress: NO FIREWALL: ${state.unenforced}; imps with a box or none policy will not start (${String(closed.length)} now)`,
        );

        return;
      }

      const handle = createQueryHandler({
        subnet: deps.config.subnet,
        ipv6: ipv6 !== null,
        checkName,
        writeAnswers,
        forward,
        maxTtlS: MIN_TTL_S,
        rate: { burst: QUERY_BURST, perSecond: QUERIES_PER_SECOND },
        now,
        log: deps.log,
      });

      state.server = await startResolverServer(
        deps.config.egressDnsPort,
        deps.config.subnet,
        handle,
      );

      state.sweep = setInterval(() => {
        void runLoggedSweep();
      }, SWEEP_MS);

      for (const slot of state.slots.keys()) {
        void resolveExactNames(slot);
      }
    },

    stop: () => {
      state.server?.stop();

      if (state.sweep !== null) {
        clearInterval(state.sweep);
      }
    },

    requirePolicy,

    requireImp: async (impId) => {
      const policy = await readEgressPolicy(deps.db, impId);

      if (policy !== undefined) {
        requirePolicy(policy);
      }
    },

    // under the policy lock: a table built here must not carry a policy
    // row that a failed setPolicy is about to put back
    addSlot: (slot) =>
      mutex.runExclusive('policy', async () => {
        state.released.delete(slot);
        sets.clear(slot);

        await applyTable();

        void resolveExactNames(slot);
      }),

    releaseSlot: (slot) =>
      mutex.runExclusive('policy', async () => {
        state.released.add(slot);

        await applyTable();
      }),

    readPolicy: async (name) => {
      const imp = await findImpByName(deps.db, name);

      const policy = imp === undefined ? undefined : await readEgressPolicy(deps.db, imp.id);

      if (policy === undefined) {
        throw buildNotFoundError('imp', name);
      }

      return policy;
    },

    // one change at a time, slots included, so a rollback never undoes a
    // later change
    setPolicy: (name, policy) =>
      mutex.runExclusive('policy', async () => {
        requirePolicy(policy);

        const imp = await findImpByName(deps.db, name);

        const previous = imp === undefined ? undefined : await readEgressPolicy(deps.db, imp.id);

        if (imp === undefined || previous === undefined) {
          throw buildNotFoundError('imp', name);
        }

        await writeEgressPolicy(deps.db, imp.id, policy);

        const rules = buildAllowRules(policy.allow);

        if (policy.mode === 'box') {
          sets.prune(imp.slot, (allowed) => isNameAllowed(rules, allowed));
        } else {
          sets.clear(imp.slot);
        }

        // the row goes back, and the table is built again from it, so nft
        // and the database agree whichever table nft last took
        try {
          await applyTable();
        } catch (error) {
          await writeEgressPolicy(deps.db, imp.id, previous);
          await tryApplyTable();

          throw error;
        }

        // the guest's own flows the new policy may deny, and the broker's
        // tunnels, which conntrack does not see
        deps.closeTunnels(imp.id, (host) => isTunnelAllowed(policy, host));

        if (policy.mode !== 'open') {
          await flushConnections(imp.ip);
        }

        void resolveExactNames(imp.slot);

        return policy;
      }),

    checkName,
    writeAnswers,
    runSweep,
  };
}

// each network's members, by the tap each sends from
function listPeerGroups(members: readonly NetworkMember[]): NetworkPeer[][] {
  const byNetwork = Map.groupBy(members, (member) => member.network);

  return [...byNetwork.values()].map((group) =>
    group.map((member) => ({ tap: `imp${String(member.slot)}`, guestIp: member.guestIp })),
  );
}

// `conntrack -D` exits 1 when it found nothing to delete
async function runConntrackFlush(guestIp: string): Promise<void> {
  const result = await runCommand(['conntrack', '-D', '-s', guestIp]);

  if (result.exitCode !== 0 && !result.stderr.includes('0 flow entries')) {
    throw new Error(
      `conntrack -D -s ${guestIp} exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  }
}

// A records, and with IPv6 AAAA too; a name with no AAAA still resolves
function createExactResolver(
  servers: readonly string[],
  ipv6: boolean,
): (name: string) => Promise<readonly AddressAnswer[]> {
  const resolver = new Resolver({ timeout: 2000, tries: 2 });

  resolver.setServers([...servers]);

  const resolveAaaa = async (name: string): Promise<readonly AddressAnswer[]> => {
    try {
      const records = await resolver.resolve6(name, { ttl: true });

      return records.map((record) => ({ address: record.address, ttlS: record.ttl }));
    } catch {
      return [];
    }
  };

  return async (name) => {
    const records = await resolver.resolve4(name, { ttl: true });

    const answers = records.map((record) => ({ address: record.address, ttlS: record.ttl }));

    if (!ipv6) {
      return answers;
    }

    const answers6 = await resolveAaaa(name);

    return [...answers, ...answers6];
  };
}
