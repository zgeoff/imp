import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { AuditEntry, BrokerRule, Secret, SecretAdded, SecretKind } from '@imp/api';
import { ORPCError } from '@orpc/server';
import {
  buildConflictError,
  buildForbiddenError,
  buildMovingError,
  buildNotFoundError,
} from '../api-errors';
import type { Config } from '../config';
import { listAuditEntries, writeAuditEntry } from '../db/broker-audit';
import type { NewAuditEntry } from '../db/broker-audit';
import { findImpByName, listImps } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import {
  createCheckedGrant,
  createForkGrants,
  createSecret,
  findBrokerPeer,
  listAllGrantedRules,
  listGrantNames,
  listGrantedRules,
  listSecrets,
  listValueFiles,
  removeCheckedGrant,
  removeSecret,
  upsertSecret,
} from '../db/secrets';
import type {
  GrantAuthority,
  GrantClash,
  GrantedRule,
  NewSecret,
  SecretRecord,
} from '../db/secrets';
import { deriveSlotAddress } from '../net/addressing';
import { readConnectedPrefixes6 } from '../net/ipv6-plan';
import type { Ipv6Plan } from '../net/ipv6-plan';
import { BLOCKED_RANGES6, createRangeChecker6 } from '../net/ranges6';
import { readErrorMessage } from '../read-error-message';
import { loadOrCreateBrokerCa } from './broker-ca';
import { startBrokerFront } from './broker-front';
import type { BrokerFront } from './broker-front';
import {
  PLACEHOLDER,
  SecretRulesError,
  listPlaceholderEnv,
  renderCredential,
  resolveRules,
} from './connector-kinds';
import { createForwarder } from './forward-request';
import type { Credential, UpstreamFetch } from './forward-request';
import {
  buildBrokerEnv,
  buildInstallInput,
  createGuestTrust,
  runBundleInstall,
} from './guest-trust';
import type { InstallBundle, TrustedImp } from './guest-trust';
import { buildValueFile, createSecretFiles } from './secret-files';
import { createTerminators } from './terminators';
import { createUpstreamResolver } from './test-upstreams';
import { resolveTunnelTarget } from './tunnel-target';

// The credential broker (docs/guides/connectors.md): secrets and grants for
// the API, the front port guests reach on their gateway, and the exec
// variables that point a guest's tools at it.

interface AddSecretInput {
  readonly name: string;
  readonly kind: SecretKind;
  readonly value: string;
  readonly rules?: readonly BrokerRule[] | undefined;
  readonly replace?: boolean | undefined;
  readonly rebind?: boolean | undefined;
}

export interface Broker {
  readonly addSecret: (input: AddSecretInput) => Promise<SecretAdded>;
  readonly listSecrets: () => Promise<Secret[]>;
  readonly deleteSecret: (name: string) => Promise<void>;

  // with an authority, the token must still exist and the secret still be
  // the one its list named (docs/guides/tokens.md#granting-secrets)
  readonly addGrant: (
    impName: string,
    secretName: string,
    authority?: Readonly<GrantAuthority> | null,
  ) => Promise<void>;
  readonly removeGrant: (
    impName: string,
    secretName: string,
    authority?: Readonly<GrantAuthority> | null,
  ) => Promise<void>;
  readonly listGrants: (impName: string) => Promise<string[]>;

  // one imp's, or every imp's; only imps within the patterns when there
  // are any
  readonly listAudit: (
    impName: string | null,
    limit: number,
    patterns: readonly string[] | null,
  ) => Promise<AuditEntry[]>;

  // a fork gets its source's grants, but none that clashes with a grant it
  // has by then; a skip or a failure is logged, not thrown, as the fork
  // exists by then
  readonly createForkGrants: (fromImpName: string, toImpName: string) => Promise<void>;

  // the variables for an exec in this imp: none without a grant, or when
  // the CA could not be put in the guest
  readonly readExecEnv: (imp: ImpRecord, vsockPath: string) => Promise<readonly string[]>;

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
  readonly resolveTunnelTarget?: (host: string) => Promise<string>;
  readonly dialTunnel?: (address: string, port: number) => Socket;

  // the IPv6 impd resolved at start; without it, tunnels dial IPv4 only
  readonly ipv6?: Ipv6Plan | null;

  // tests hold a request between its rule read and its value read
  readonly afterRuleRead?: () => Promise<void>;
}

// how long the container's own IPv6 prefixes stay read
const CONNECTED_CACHE_MS = 30_000;

export async function createBroker(deps: BrokerDeps): Promise<Broker> {
  const config = deps.config;
  const db = deps.db;
  const log = deps.log;
  const brokerDir = join(config.dataDir, 'broker');

  const ca = await loadOrCreateBrokerCa(join(brokerDir, 'ca'));

  const blocked6: { check: ((address: string) => boolean) | null; readAt: number } = {
    check: null,
    readAt: 0,
  };

  // with IPv6, what no tunnel dials: the fixed ranges, the imps' /64, and
  // the container's own links, read again every CONNECTED_CACHE_MS
  const readBlocked6 = async (): Promise<((address: string) => boolean) | null> => {
    const ipv6 = deps.ipv6 ?? null;

    if (ipv6 === null) {
      return null;
    }

    if (blocked6.check === null || Date.now() - blocked6.readAt > CONNECTED_CACHE_MS) {
      const connected = await readConnectedPrefixes6();

      blocked6.check = createRangeChecker6([...BLOCKED_RANGES6, ipv6.prefix.text, ...connected]);
      blocked6.readAt = Date.now();
    }

    return blocked6.check;
  };

  const resolveTarget = async (host: string): Promise<string> => {
    const isBlocked6 = await readBlocked6();

    return resolveTunnelTarget(host, { isBlocked6 });
  };

  const files = createSecretFiles(config.dataDir);

  // a value no row names: a write whose row never came, or a file a replace
  // or a delete displaced and impd stopped before removing
  const valueFiles = await listValueFiles(db);

  files.removeExcept(valueFiles);

  const resolveUpstream = createUpstreamResolver(config.brokerTestUpstreams, log);

  const trust = createGuestTrust(
    buildInstallInput(ca.certPem),
    deps.installBundle ?? runBundleInstall,
    log,
  );

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

    const value = granted === undefined ? null : files.read(granted.valueFile);

    if (granted === undefined || value === null) {
      return null;
    }

    return {
      secretName: granted.secretName,
      header: granted.rule.header,
      value: renderCredential(granted.rule, value),
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

  const terminators = createTerminators({
    socketDir: join(brokerDir, 'run'),
    issueLeaf: ca.issueLeaf,
    isLeafDue: (leaf) => ca.isDue(leaf, Date.now()),
    createHandler: (key) =>
      createForwarder({
        impId: key.impId,
        host: key.host,
        findCredential,
        resolveUpstream,
        recordAudit: (entry) => {
          void writeAudit(entry);
        },
        ...(deps.fetch !== undefined && { fetch: deps.fetch }),
      }),
  });

  const state: { front: BrokerFront | null; port: number } = {
    front: null,
    port: config.brokerPort,
  };

  const requireImp = async (name: string): Promise<ImpRecord> => {
    const imp = await findImpByName(db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp;
  };

  const toApiSecret = async (secret: SecretRecord): Promise<Secret> => {
    const listed = await listSecrets(db);

    const imps = listed.find((entry) => entry.secret.name === secret.name)?.imps ?? [];

    return {
      name: secret.name,
      kind: secret.kind,
      rules: secret.rules,
      imps,
      createdAt: secret.createdAt,
    };
  };

  // The row for a value just written to its file, which goes again when no
  // row names it; with replace, the file the row named before.
  const writeSecretRow = async (
    secret: Readonly<NewSecret>,
    input: Readonly<AddSecretInput>,
  ): Promise<{
    readonly secret: SecretRecord;
    readonly oldValueFile: string | null;
    readonly droppedGrants: number;
  }> => {
    try {
      if (input.replace !== true) {
        const made = await createSecret(db, secret);

        if (made === null) {
          throw buildConflictError('secret', secret.name);
        }

        return { secret: made, oldValueFile: null, droppedGrants: 0 };
      }

      const outcome = await upsertSecret(db, secret, input.rebind === true);

      if (outcome.kind === 'binding-changed') {
        throw buildBindingChangedError(secret.name);
      }

      return outcome;
    } catch (error) {
      files.remove(secret.valueFile);
      throw error;
    }
  };

  // the exact file the commit displaced; a failure leaves it to the sweep
  // at the next start
  const removeDisplacedFile = (file: string): void => {
    try {
      files.remove(file);
    } catch (error) {
      log(`impd: broker: could not remove an old secret value file: ${readErrorMessage(error)}`);
    }
  };

  // never rejects: it runs from a timer and from imp changes
  const applyGrants = async (): Promise<void> => {
    try {
      const [granted, imps] = await Promise.all([listAllGrantedRules(db), listImps(db)]);

      const live = new Set(granted.map((entry) => `${entry.impId}\n${entry.rule.host}`));

      await terminators.prune((key) => live.has(`${key.impId}\n${key.host}`));

      trust.forgetExcept(new Set(imps.map((imp) => imp.id)));
    } catch (error) {
      log(`impd: broker: could not apply grants: ${readErrorMessage(error)}`);
    }
  };

  return {
    addSecret: async (input) => {
      let rules: readonly BrokerRule[];

      try {
        rules = resolveRules(input.kind, input.rules);
      } catch (error) {
        if (error instanceof SecretRulesError) {
          throw new ORPCError('BAD_REQUEST', { message: error.message });
        }

        throw error;
      }

      const valueFile = buildValueFile(input.name);

      // the value first, so no row ever names a file that is not there
      files.write(valueFile, input.value);

      const saved = await writeSecretRow(
        { name: input.name, kind: input.kind, rules, valueFile },
        input,
      );

      if (saved.oldValueFile !== null) {
        removeDisplacedFile(saved.oldValueFile);

        await applyGrants();
      }

      const shown = await toApiSecret(saved.secret);

      return { ...shown, droppedGrants: saved.droppedGrants };
    },

    listSecrets: async () => {
      const listed = await listSecrets(db);

      return listed.map((entry) => ({
        name: entry.secret.name,
        kind: entry.secret.kind,
        rules: entry.secret.rules,
        imps: entry.imps,
        createdAt: entry.secret.createdAt,
      }));
    },

    deleteSecret: async (name) => {
      const valueFile = await removeSecret(db, name);

      if (valueFile === null) {
        throw buildNotFoundError('secret', name);
      }

      removeDisplacedFile(valueFile);

      await applyGrants();
    },

    addGrant: async (impName, secretName, authority = null) => {
      const imp = await requireImp(impName);

      // a send carries the grants it read at its start; a target's staged
      // imp takes the ones the stream named
      if (imp.moveState === 'sending' || imp.moveState === 'moved') {
        throw buildMovingError(impName);
      }

      const outcome = await createCheckedGrant(db, imp.id, secretName, authority);

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

    listAudit: async (impName, limit, patterns) => {
      const imp = impName === null ? null : await requireImp(impName);

      return listAuditEntries(db, imp?.id ?? null, Math.min(limit, 1000), patterns);
    },

    createForkGrants: async (fromImpName, toImpName) => {
      try {
        const [from, to] = await Promise.all([requireImp(fromImpName), requireImp(toImpName)]);
        const skipped = await createForkGrants(db, from.id, to.id);

        for (const name of skipped) {
          log(
            `impd: ${toImpName}: forked without grant ${name} of ${fromImpName}: it has another credential for that host`,
          );
        }
      } catch (error) {
        log(
          `impd: ${toImpName}: forked without the grants of ${fromImpName}: ${readErrorMessage(error)}`,
        );
      }
    },

    readExecEnv: async (imp, vsockPath) => {
      const granted = await listGrantedRules(db, imp.id);

      if (granted.length === 0) {
        return [];
      }

      const trusted: TrustedImp = { id: imp.id, name: imp.name, pid: imp.pid };

      if (!(await trust.ensure(trusted, vsockPath))) {
        return [];
      }

      const gateway = deriveSlotAddress(imp.slot, {
        subnet: config.subnet,
        portBase: config.portBase,
      }).hostIp;

      return buildBrokerEnv({
        proxyUrl: `http://${gateway}:${String(state.port)}`,
        placeholders: listPlaceholderEnv(granted.map((entry) => entry.kind)),
        placeholder: PLACEHOLDER,
      });
    },

    applyGrants,

    closeTunnels: (impId, keep) => {
      state.front?.closeTunnels(impId, keep);
    },

    isGranted: async (impId, host) => (await findRule(impId, host)) !== undefined,

    listen: async (port) => {
      const front = await startBrokerFront(port, {
        subnet: config.subnet,
        findPeer: (slot) => findBrokerPeer(db, slot),
        isGranted: async (impId, host) => (await findRule(impId, host)) !== undefined,
        openTerminator: terminators.open,
        resolveTunnelTarget: deps.resolveTunnelTarget ?? resolveTarget,
        ...(deps.dialTunnel !== undefined && { dialTunnel: deps.dialTunnel }),
        log,
      });

      const address = front.server.address();

      state.front = front;
      state.port = typeof address === 'object' && address !== null ? address.port : port;

      return state.port;
    },

    stop: async () => {
      await state.front?.stop();
      await terminators.stop();
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

// a replace with another kind or rules, without rebind
function buildBindingChangedError(name: string) {
  return new ORPCError('CONFLICT', {
    message: `secret ${name} would get other hosts or headers; a rebind (--rebind) drops its grants`,
    data: { kind: 'secret', name, reason: 'binding_changed' },
  });
}

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
