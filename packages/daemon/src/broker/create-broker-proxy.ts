import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { EgressMode } from '@impz/api';
import type { Config } from '../config';
import { writeAuditEntry } from '../db/broker-audit';
import type { NewAuditEntry } from '../db/broker-audit';
import type { ImpDatabase } from '../db/open-database';
import { findBrokerPeer, listGrantedRules } from '../db/secrets';
import type { GrantedRule } from '../db/secrets';
import { readConnectedPrefixes4, readRouteDevice, readUplinks } from '../net/host-routes';
import type { Uplinks } from '../net/host-routes';
import { readConnectedPrefixes6 } from '../net/ipv6-plan';
import type { Ipv6Plan } from '../net/ipv6-plan';
import { createRangeChecker } from '../net/range-checker';
import {
  BLOCKED_RANGES6,
  DOCUMENTATION_RANGES6,
  RESERVED_RANGES6,
  createRangeChecker6,
} from '../net/ranges6';
import { createTtlCache } from '../process/ttl-cache';
import { readErrorMessage } from '../read-error-message';
import type { BrokerCa } from './broker-ca';
import { startBrokerFront } from './broker-front';
import type { BrokerFront } from './broker-front';
import { renderCredential } from './connector-kinds';
import { createForwarder } from './forward-request';
import type { Credential, UpstreamFetch } from './forward-request';
import { parseOAuthState } from './oauth-state';
import { createRefusalBudget } from './refusal-budget';
import type { SecretFiles } from './secret-files';
import { createTerminators } from './terminators';
import type { TerminatorKey } from './terminators';
import type { ResolveUpstream } from './test-upstreams';
import { requireUplinkRoute, resolveTunnelTarget } from './tunnel-target';

// The broker's request path (docs/guides/connectors.md): the front port
// guests reach on their gateway, a plain tunnel to an ungranted host, and a
// TLS terminator per granted host that sends the real credential on.

interface BrokerProxy {
  // true when a grant of the imp covers the host
  readonly isGranted: (impId: string, host: string) => Promise<boolean>;

  // stops the terminators `keep` rejects
  readonly prune: (keep: (key: TerminatorKey) => boolean) => Promise<void>;

  // ends the imp's plain tunnels to hosts `keep` rejects
  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;

  // opens the front port on every address; 0 picks a free port, which it
  // returns
  readonly listen: (port: number) => Promise<number>;

  // the front port, the configured one until listen
  readonly getPort: () => number;
  readonly stop: () => Promise<void>;
}

interface BrokerProxyDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly files: Pick<SecretFiles, 'read'>;
  readonly log: (message: string) => void;
  readonly now: () => number;
  readonly ca: BrokerCa;
  readonly resolveUpstream: ResolveUpstream;
  readonly fetch?: UpstreamFetch | undefined;
  readonly resolveTunnelTarget?: ((host: string, mode: EgressMode) => Promise<string>) | undefined;
  readonly dialTunnel?: ((address: string, port: number) => Socket) | undefined;
  readonly ipv6?: Ipv6Plan | null | undefined;
  readonly afterRuleRead?: (() => Promise<void>) | undefined;
}

// how long the container's own prefixes stay read
const CONNECTED_CACHE_MS = 30_000;

// the refused requests of one imp audited in one second; past it, the rest
// of that second's refusals get no row
const REFUSED_AUDITS_PER_SECOND = 20;

export function createBrokerProxy(deps: BrokerProxyDeps): BrokerProxy {
  const config = deps.config;
  const db = deps.db;
  const files = deps.files;
  const log = deps.log;
  const now = deps.now;
  const ca = deps.ca;

  // the container's own prefixes, each read again once it is more than
  // CONNECTED_CACHE_MS old
  const blocked6 = createTtlCache<'blocked6', (address: string) => boolean>({
    max: 1,
    ttlMs: CONNECTED_CACHE_MS,
    now,
  });

  // with IPv6, what no tunnel dials: the fixed ranges, the imps' /64, and
  // the container's own links
  const readBlocked6 = async (): Promise<((address: string) => boolean) | null> => {
    const ipv6 = deps.ipv6 ?? null;

    if (ipv6 === null) {
      return null;
    }

    const cached = blocked6.get('blocked6');

    if (cached !== undefined) {
      return cached;
    }

    const connected = await readConnectedPrefixes6();

    const check = createRangeChecker6([...BLOCKED_RANGES6, ipv6.prefix.text, ...connected]);

    blocked6.set('blocked6', check);

    return check;
  };

  const publicRefused = createTtlCache<
    'public',
    { readonly check: (address: string) => boolean; readonly uplinks: Uplinks }
  >({ max: 1, ttlMs: CONNECTED_CACHE_MS, now });

  // what a public imp's tunnel may not dial beyond every tunnel's ranges,
  // as its firewall refuses it: the container's IPv4 networks (can be
  // public), IMP_EGRESS_DENY and the IPv6 ranges refused to public only
  const readPublicRefused = async (): Promise<{
    readonly check: (address: string) => boolean;
    readonly uplinks: Uplinks;
  }> => {
    const cached = publicRefused.get('public');

    if (cached !== undefined) {
      return cached;
    }

    const connected = await readConnectedPrefixes4();
    const uplinks = await readUplinks();

    const deny = config.egressDeny;

    const check = createRangeChecker(
      [...connected, ...deny.filter((cidr) => !cidr.includes(':'))],
      [...DOCUMENTATION_RANGES6, ...RESERVED_RANGES6, ...deny.filter((cidr) => cidr.includes(':'))],
    );

    publicRefused.set('public', { check, uplinks });

    return { check, uplinks };
  };

  const resolveTarget = async (host: string, mode: EgressMode): Promise<string> => {
    const isBlocked6 = await readBlocked6();

    if (mode !== 'public') {
      return resolveTunnelTarget(host, { isBlocked6 });
    }

    const refused = await readPublicRefused();
    const address = await resolveTunnelTarget(host, { isBlocked6, isRefusedMore: refused.check });

    // as the firewall's uplink rule: a route by another interface reaches
    // a private service whatever the address
    await requireUplinkRoute(host, address, refused.uplinks, readRouteDevice);

    return address;
  };

  const findRule = async (impId: string, host: string): Promise<GrantedRule | undefined> => {
    const rules = await listGrantedRules(db, impId);

    return rules.find((granted) => granted.rule.host === host);
  };

  // The value comes from the file the rule's row names: a replace writes a
  // new file and switches the row, so the old host never gets the new value.
  // A request that read the row just before finds the old file gone.
  const findCredential = async (impId: string, host: string): Promise<Credential | null> => {
    const granted = await findRule(impId, host);

    await deps.afterRuleRead?.();

    const stored = granted === undefined ? null : files.read(granted.valueFile);

    // an oauth secret's file is its state; the credential is the access token
    const value =
      granted?.kind === 'oauth' && stored !== null
        ? (parseOAuthState(stored)?.accessToken ?? null)
        : stored;

    if (granted === undefined || value === null) {
      return null;
    }

    return {
      secretName: granted.secretName,
      header: granted.rule.header,
      value: renderCredential(granted.rule, value),
      upstream: granted.rule.upstream ?? null,
      filter: granted.filter,
    };
  };

  // the audit write must never fail the request it describes
  const writeAudit = async (entry: Readonly<NewAuditEntry>): Promise<void> => {
    try {
      await writeAuditEntry(db, entry);
    } catch (error) {
      log(`impd: broker: audit write failed: ${readErrorMessage(error)}`);
    }
  };

  const refusals = createRefusalBudget({ perSecond: REFUSED_AUDITS_PER_SECOND, now });

  // every request sent with a credential, and the refused ones within the
  // imp's budget
  const writeBudgetedAudit = (entry: NewAuditEntry): void => {
    if (entry.reason === null || refusals.tryClaim(entry.impId)) {
      void writeAudit(entry);
    }
  };

  const terminators = createTerminators({
    socketDir: join(config.dataDir, 'broker', 'run'),
    issueLeaf: ca.issueLeaf,
    isLeafDue: (leaf) => ca.isDue(leaf, now()),
    createHandler: (key) =>
      createForwarder({
        impId: key.impId,
        host: key.host,
        findCredential,
        resolveUpstream: deps.resolveUpstream,
        recordAudit: writeBudgetedAudit,
        ...(deps.fetch !== undefined && { fetch: deps.fetch }),
      }),
  });

  const state: { front: BrokerFront | null; port: number } = {
    front: null,
    port: config.brokerPort,
  };

  const isGranted = async (impId: string, host: string): Promise<boolean> =>
    (await findRule(impId, host)) !== undefined;

  return {
    isGranted,

    prune: (keep) => terminators.prune(keep),

    closeTunnels: (impId, keep) => {
      state.front?.closeTunnels(impId, keep);
    },

    listen: async (port) => {
      const front = await startBrokerFront(port, {
        subnet: config.subnet,
        findPeer: (slot) => findBrokerPeer(db, slot),
        isGranted,
        openTerminator: terminators.open,
        resolveTunnelTarget: deps.resolveTunnelTarget ?? resolveTarget,
        ...(deps.dialTunnel !== undefined && { dialTunnel: deps.dialTunnel }),
        recordAudit: writeBudgetedAudit,
        log,
      });

      const address = front.server.address();

      state.front = front;
      state.port = typeof address === 'object' && address !== null ? address.port : port;

      return state.port;
    },

    getPort: () => state.port,

    stop: async () => {
      await state.front?.stop();
      await terminators.stop();
    },
  };
}
