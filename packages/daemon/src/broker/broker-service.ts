import type { Socket } from 'node:net';
import { join } from 'node:path';
import type { AuditEntry, BrokerRule, Secret, SecretKind } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { buildConflictError, buildNotFoundError } from '../api-errors';
import type { Config } from '../config';
import { listAuditEntries, writeAuditEntry } from '../db/broker-audit';
import type { NewAuditEntry } from '../db/broker-audit';
import { findImpByName, listImps } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import {
  createForkGrants,
  createGrant,
  findBrokerPeer,
  findSecret,
  listAllGrantedRules,
  listGrantNames,
  listGrantedRules,
  listSecrets,
  removeGrant,
  removeSecret,
  writeSecret,
} from '../db/secrets';
import type { GrantedRule, SecretRecord } from '../db/secrets';
import { deriveSlotAddress } from '../net/addressing';
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
import { createSecretFiles } from './secret-files';
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
}

export interface Broker {
  readonly addSecret: (input: AddSecretInput) => Promise<Secret>;
  readonly listSecrets: () => Promise<Secret[]>;
  readonly deleteSecret: (name: string) => Promise<void>;
  readonly addGrant: (impName: string, secretName: string) => Promise<void>;
  readonly removeGrant: (impName: string, secretName: string) => Promise<void>;
  readonly listGrants: (impName: string) => Promise<string[]>;

  // one imp's, or every imp's; only imps within the patterns when there
  // are any
  readonly listAudit: (
    impName: string | null,
    limit: number,
    patterns: readonly string[] | null,
  ) => Promise<AuditEntry[]>;

  // a fork gets its source's grants; a failure is logged, not thrown, as
  // the fork exists by then
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
}

export async function createBroker(deps: BrokerDeps): Promise<Broker> {
  const config = deps.config;
  const db = deps.db;
  const log = deps.log;
  const brokerDir = join(config.dataDir, 'broker');

  const ca = await loadOrCreateBrokerCa(join(brokerDir, 'ca'));

  const files = createSecretFiles(config.dataDir);
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

  const findCredential = async (impId: string, host: string): Promise<Credential | null> => {
    const granted = await findRule(impId, host);

    const value = granted === undefined ? null : files.read(granted.secretName);

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

  const requireSecret = async (name: string): Promise<SecretRecord> => {
    const secret = await findSecret(db, name);

    if (secret === undefined) {
      throw buildNotFoundError('secret', name);
    }

    return secret;
  };

  // A host may have one credential per imp: two would leave the header
  // ambiguous. Checked against the imp's other grants.
  const requireNoClash = async (
    imp: ImpRecord,
    secretName: string,
    rules: readonly BrokerRule[],
  ): Promise<void> => {
    const granted = await listGrantedRules(db, imp.id);

    const clash = granted.find(
      (other) =>
        other.secretName !== secretName && rules.some((rule) => rule.host === other.rule.host),
    );

    if (clash !== undefined) {
      throw buildConflictError(
        'grant',
        `${imp.name}/${secretName}`,
        `secret ${clash.secretName} already gives ${imp.name} a credential for ${clash.rule.host}`,
      );
    }
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

      const secret = { name: input.name, kind: input.kind, rules };

      if (input.replace !== true) {
        const saved = await writeSecret(db, secret, false);

        if (saved === null) {
          throw buildConflictError('secret', input.name);
        }

        try {
          files.write(input.name, input.value);
        } catch (error) {
          await removeSecret(db, input.name);

          throw error;
        }

        return toApiSecret(saved);
      }

      const existing = await findSecret(db, input.name);

      const shown = existing === undefined ? null : await toApiSecret(existing);
      const grantedTo = shown?.imps ?? [];

      for (const impName of grantedTo) {
        const imp = await requireImp(impName);

        await requireNoClash(imp, input.name, rules);
      }

      // the value first: a failed write leaves the old secret as it was
      files.write(input.name, input.value);

      const saved = await writeSecret(db, secret, true);

      if (saved === null) {
        throw new Error(`secret ${input.name} was not saved`);
      }

      await applyGrants();

      return toApiSecret(saved);
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
      if (!(await removeSecret(db, name))) {
        throw buildNotFoundError('secret', name);
      }

      files.remove(name);

      await applyGrants();
    },

    addGrant: async (impName, secretName) => {
      const imp = await requireImp(impName);
      const secret = await requireSecret(secretName);

      await requireNoClash(imp, secret.name, secret.rules);
      await createGrant(db, imp.id, secret.name);
    },

    removeGrant: async (impName, secretName) => {
      const imp = await requireImp(impName);

      if (!(await removeGrant(db, imp.id, secretName))) {
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

        await createForkGrants(db, from.id, to.id);
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
        resolveTunnelTarget: deps.resolveTunnelTarget ?? ((host) => resolveTunnelTarget(host)),
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
