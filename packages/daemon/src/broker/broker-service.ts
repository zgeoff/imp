import type { Socket } from 'node:net';
import { join } from 'node:path';
import type {
  AuditEntry,
  EgressMode,
  Grant,
  GrantFilter,
  GrantNotCopied,
  RefusedRequest,
  Secret,
  SecretAdded,
} from '@impz/api';
import { ORPCError } from '@orpc/server';
import {
  buildConflictError,
  buildForbiddenError,
  buildMovingError,
  buildNotFoundError,
} from '../api-errors';
import type { Config } from '../config';
import { listAuditEntries, listRefusedRequests } from '../db/broker-audit';
import { findImpByName, listImps } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import {
  createCheckedGrant,
  createForkGrants,
  listAllGrantedRules,
  listGrantNames,
  listGrantedRules,
  listGrants,
  removeCheckedGrant,
} from '../db/secrets';
import type { ForkAuthority, GrantAuthority, GrantClash } from '../db/secrets';
import { deriveSlotAddress } from '../net/addressing';
import type { Ipv6Plan } from '../net/ipv6-plan';
import { readErrorMessage } from '../read-error-message';
import { loadOrCreateBrokerCa } from './broker-ca';
import { PLACEHOLDER, listPlaceholderEnv } from './connector-kinds';
import { createBrokerProxy } from './create-broker-proxy';
import { createSecretStore } from './create-secret-store';
import type { AddSecretInput } from './create-secret-store';
import type { UpstreamFetch } from './forward-request';
import {
  buildBrokerEnv,
  buildInstallInput,
  createGuestTrust,
  runBundleInstall,
} from './guest-trust';
import type { BrokerExecEnv, InstallBundle, TrustedImp } from './guest-trust';
import { createOAuthRefresher } from './oauth-refresher';
import type { OAuthFetch } from './oauth-refresher';
import { removeStaleSecretFiles } from './remove-stale-secret-files';
import { createSecretFiles } from './secret-files';
import type { SecretFiles } from './secret-files';
import { createUpstreamResolver } from './test-upstreams';

// The credential broker (docs/guides/connectors.md): grants for the API, the
// exec variables that point a guest's tools at it, and the secret store and
// request path it puts together.

// what a fork's copy of its source's grants did: the grants it skipped, and
// a message when it copied none because the copy failed as a whole
interface ForkGrantsReport {
  readonly notCopied: readonly GrantNotCopied[];
  readonly error: string | null;
}

// an imp by id, not by name, which another imp may take meanwhile; the
// name is for the log
interface ForkEnd {
  readonly id: string;
  readonly name: string;
}

export interface Broker {
  readonly addSecret: (input: AddSecretInput) => Promise<SecretAdded>;
  readonly listSecrets: () => Promise<Secret[]>;

  // forces one refresh of an oauth secret and answers after it ends
  readonly refreshSecret: (name: string) => Promise<Secret>;
  readonly deleteSecret: (name: string) => Promise<void>;

  // with an authority, the token must still exist and the secret still be
  // the one its list named (docs/guides/tokens.md#granting-secrets); a
  // filter replaces the grant's own, and none keeps it
  readonly addGrant: (
    impName: string,
    secretName: string,
    authority?: Readonly<GrantAuthority> | null,
    filter?: GrantFilter,
  ) => Promise<void>;
  readonly removeGrant: (
    impName: string,
    secretName: string,
    authority?: Readonly<GrantAuthority> | null,
  ) => Promise<void>;
  readonly listGrants: (impName: string) => Promise<string[]>;

  // the same, each with its filter
  readonly listGrantDetails: (impName: string) => Promise<Grant[]>;

  // one imp's, or every imp's; only imps within the patterns when there
  // are any
  readonly listAudit: (
    impName: string | null,
    limit: number,
    patterns: readonly string[] | null,
  ) => Promise<AuditEntry[]>;

  // the requests it refused, by the same rules as listAudit
  readonly listRefused: (
    impName: string | null,
    limit: number,
    patterns: readonly string[] | null,
  ) => Promise<RefusedRequest[]>;

  // as db createForkGrants; a skip or a failure is logged and reported,
  // not thrown, as the fork exists by then
  readonly createForkGrants: (
    source: Readonly<ForkEnd>,
    fork: Readonly<ForkEnd>,
    authority: Readonly<ForkAuthority> | null,
  ) => Promise<ForkGrantsReport>;

  // the variables for an exec in this imp: none without a grant, or when
  // the CA could not be put in this boot of the guest
  readonly readExecEnv: (imp: ImpRecord, vsockPath: string) => Promise<BrokerExecEnv>;

  // drops terminators no grant covers and forgets destroyed imps; logs a
  // failure rather than throwing
  readonly applyGrants: () => Promise<void>;

  // true when a grant of the imp covers the host
  readonly isGranted: (impId: string, host: string) => Promise<boolean>;

  // ends the imp's plain tunnels to hosts `keep` rejects
  readonly closeTunnels: (impId: string, keep: (host: string) => boolean) => void;

  // opens the front port on every address; 0 picks a free port, which it
  // returns
  readonly listen: (port: number) => Promise<number>;
  readonly stop: () => Promise<void>;
}

export interface BrokerDeps {
  readonly config: Config;
  readonly db: ImpDatabase;
  readonly log: (message: string) => void;

  // tests stand in for the guest install and for the network
  readonly installBundle?: InstallBundle;
  readonly fetch?: UpstreamFetch;
  readonly oauthFetch?: OAuthFetch;
  readonly now?: () => number;

  // false in tests that run no refresh timer
  readonly runOAuthTimer?: boolean;
  readonly resolveTunnelTarget?: (host: string, mode: EgressMode) => Promise<string>;
  readonly dialTunnel?: (address: string, port: number) => Socket;

  // the IPv6 impd resolved at start; without it, tunnels dial IPv4 only
  readonly ipv6?: Ipv6Plan | null;

  // tests hold a request between its rule read and its value read, and
  // stand in for the value files
  readonly afterRuleRead?: () => Promise<void>;

  // tests act between a grant call's access check and its transaction: a
  // grant, a revoke, or a fork's copy runs this first
  readonly beforeGrantWrite?: () => Promise<void>;
  readonly secretFiles?: SecretFiles;
}

export async function createBroker(deps: BrokerDeps): Promise<Broker> {
  const config = deps.config;
  const db = deps.db;
  const log = deps.log;
  const now = deps.now ?? Date.now;

  const ca = await loadOrCreateBrokerCa(join(config.dataDir, 'broker', 'ca'), now);

  const files = deps.secretFiles ?? createSecretFiles(config.dataDir);

  await removeStaleSecretFiles(db, files, new Date(now()), log);

  const resolveUpstream = createUpstreamResolver(config.brokerTestUpstreams, log);

  const trust = createGuestTrust(
    buildInstallInput(ca.certPem),
    deps.installBundle ?? runBundleInstall,
    log,
  );

  // a stop, sleep or halt ends the imp's boot, even if its pid comes back
  const unwatch = db.writes.subscribe((write) => {
    if (write.kind === 'added' || write.kind === 'changed') {
      trust.observe(write.imp);
    }
  });

  const refresher = createOAuthRefresher({
    db,
    files,
    log,
    resolveUpstream,
    ...(deps.oauthFetch !== undefined && { fetch: deps.oauthFetch }),
    ...(deps.now !== undefined && { now: deps.now }),
  });

  const proxy = createBrokerProxy({
    config,
    db,
    files,
    log,
    now,
    ca,
    resolveUpstream,
    fetch: deps.fetch,
    resolveTunnelTarget: deps.resolveTunnelTarget,
    dialTunnel: deps.dialTunnel,
    ipv6: deps.ipv6,
    afterRuleRead: deps.afterRuleRead,
    refreshAfterRejection: refresher.refreshAfterRejection,
  });

  const requireImp = async (name: string): Promise<ImpRecord> => {
    const imp = await findImpByName(db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp;
  };

  if (deps.runOAuthTimer !== false) {
    refresher.start();
  }

  // never rejects: it runs from a timer and from imp changes
  const applyGrants = async (): Promise<void> => {
    try {
      const [granted, imps] = await Promise.all([listAllGrantedRules(db), listImps(db)]);

      const live = new Set(granted.map((entry) => `${entry.impId}\n${entry.rule.host}`));

      await proxy.prune((key) => live.has(`${key.impId}\n${key.host}`));

      trust.forgetExcept(new Set(imps.map((imp) => imp.id)));
    } catch (error) {
      log(`impd: broker: could not apply grants: ${readErrorMessage(error)}`);
    }
  };

  const secrets = createSecretStore({ db, files, log, refresher, applyGrants });

  return {
    addSecret: secrets.addSecret,
    listSecrets: secrets.listSecrets,
    refreshSecret: secrets.refreshSecret,
    deleteSecret: secrets.deleteSecret,

    addGrant: async (impName, secretName, authority, filter) => {
      const imp = await requireImp(impName);

      // a send carries the grants it read at its start; a target's staged
      // imp takes the ones the stream named
      if (imp.moveState === 'sending' || imp.moveState === 'moved') {
        throw buildMovingError(impName);
      }

      if (deps.beforeGrantWrite !== undefined) {
        await deps.beforeGrantWrite();
      }

      const outcome = await createCheckedGrant(db, imp.id, secretName, authority ?? null, filter);

      switch (outcome.kind) {
        case 'granted': {
          return;
        }
        case 'no-secret': {
          throw buildNotFoundError('secret', secretName);
        }
        case 'no-token': {
          throw buildTokenGoneError();
        }
        case 'not-grantable': {
          throw buildStaleError(secretName);
        }
        case 'clash': {
          throw buildClashError(impName, secretName, outcome.clash);
        }
      }
    },

    removeGrant: async (impName, secretName, authority = null) => {
      const imp = await requireImp(impName);

      if (imp.moveState !== null) {
        throw buildMovingError(impName);
      }

      if (deps.beforeGrantWrite !== undefined) {
        await deps.beforeGrantWrite();
      }

      const outcome = await removeCheckedGrant(db, imp.id, secretName, authority);

      if (outcome.kind === 'no-token') {
        throw buildTokenGoneError();
      }

      if (outcome.kind === 'not-grantable') {
        throw buildStaleError(secretName);
      }

      if (outcome.kind === 'no-grant') {
        throw buildNotFoundError('grant', `${impName}/${secretName}`);
      }

      await applyGrants();
    },

    listGrants: async (impName) => {
      const imp = await requireImp(impName);

      return listGrantNames(db, imp.id);
    },

    listGrantDetails: async (impName) => {
      const imp = await requireImp(impName);

      return listGrants(db, imp.id);
    },

    listAudit: async (impName, limit, patterns) => {
      const imp = impName === null ? null : await requireImp(impName);

      return listAuditEntries(db, imp?.id ?? null, Math.min(limit, 1000), patterns);
    },

    listRefused: async (impName, limit, patterns) => {
      const imp = impName === null ? null : await requireImp(impName);

      return listRefusedRequests(db, imp?.id ?? null, Math.min(limit, 1000), patterns);
    },

    createForkGrants: async (source, fork, authority) => {
      if (deps.beforeGrantWrite !== undefined) {
        await deps.beforeGrantWrite();
      }

      try {
        const outcome = await createForkGrants(db, source.id, fork.id, authority);

        if (outcome.kind === 'no-token') {
          log(
            `impd: ${fork.name}: forked without the grants of ${source.name}: the token was removed`,
          );

          return { notCopied: [], error: FORK_TOKEN_GONE };
        }

        for (const skipped of outcome.notCopied) {
          log(
            `impd: ${fork.name}: forked without grant ${skipped.secret} of ${source.name}: ${FORK_SKIP_CAUSES[skipped.reason]}`,
          );
        }

        return { notCopied: outcome.notCopied, error: null };
      } catch (error) {
        log(
          `impd: ${fork.name}: forked without the grants of ${source.name}: ${readErrorMessage(error)}`,
        );

        return { notCopied: [], error: FORK_COPY_FAILED };
      }
    },

    readExecEnv: async (imp, vsockPath) => {
      const granted = await listGrantedRules(db, imp.id);

      if (granted.length === 0) {
        return { kind: 'ungranted' };
      }

      const trusted: TrustedImp = { id: imp.id, name: imp.name, pid: imp.pid };

      const outcome = await trust.ensure(trusted, vsockPath);

      if (!outcome.installed) {
        return { kind: 'untrusted', detail: outcome.detail };
      }

      const gateway = deriveSlotAddress(imp.slot, {
        subnet: config.subnet,
        portBase: config.portBase,
      }).hostIp;

      const env = buildBrokerEnv({
        proxyUrl: `http://${gateway}:${String(proxy.getPort())}`,
        placeholders: listPlaceholderEnv(granted.map((entry) => entry.kind)),
        placeholder: PLACEHOLDER,
      });

      return { kind: 'ready', env };
    },

    applyGrants,

    closeTunnels: proxy.closeTunnels,

    isGranted: proxy.isGranted,

    listen: proxy.listen,

    stop: async () => {
      unwatch();

      await refresher.stop();
      await proxy.stop();
    },
  };
}

function buildClashError(impName: string, secretName: string, clash: Readonly<GrantClash>) {
  return buildConflictError(
    'grant',
    `${impName}/${secretName}`,
    `secret ${clash.secretName} already gives ${impName} a credential for ${clash.host}`,
  );
}

const FORK_SKIP_CAUSES: Readonly<Record<GrantNotCopied['reason'], string>> = {
  'not-grantable': 'the caller may not grant it',
  clash: 'it has another credential for that host',
  'no-secret': 'the secret is gone',
};

// what a fork answers when its copy made no grant at all; the cause of a
// failure stays in impd's log
const FORK_TOKEN_GONE =
  "the token behind this fork was removed, so it got none of the source's grants";

const FORK_COPY_FAILED =
  "the source's grants could not be copied, so the fork has none; impd's log has the cause";

// the token behind the call was removed after its access check
function buildTokenGoneError() {
  return new ORPCError('UNAUTHORIZED', { message: 'the token behind this call was removed' });
}

// the call came through a grantable list whose entry is stale: the secret
// was deleted, and maybe made again, since the access check
function buildStaleError(secretName: string) {
  return buildForbiddenError(
    `secret ${secretName} is not one this caller may grant`,
    'not_grantable',
  );
}
