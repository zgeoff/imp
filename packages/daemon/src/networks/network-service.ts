import type { Network, NetworkJoin } from '@imp/api';
import { buildConflictError, buildNotFoundError } from '../api-errors';
import { listEgressSlots } from '../db/egress';
import { findImpByName } from '../db/imps';
import {
  findNetworkByName,
  listNetworkMembers,
  listNetworks,
  removeMember,
  removeNetwork,
  writeMember,
  writeNetwork,
  writeNetworkWithMembers,
} from '../db/networks';
import type { NetworkRecord } from '../db/networks';
import type { ImpDatabase } from '../db/open-database';
import type { EgressService } from '../egress/egress-service';
import type { ImpCheckpointHooks } from '../imps/imp-service';

// Private networks between imps (docs/guides/networks.md). Every change to
// who is on a network goes through the egress firewall's lock, which builds
// the table from these rows.

export interface NetworkDeps {
  readonly db: ImpDatabase;
  readonly egress: Pick<EgressService, 'changeNetworks'>;

  // a join holds the imp's lock, which refuses an imp a move marked
  readonly imps: Pick<ImpCheckpointHooks, 'lockImp'>;
}

export interface NetworkService {
  readonly listNetworks: () => Promise<Network[]>;
  readonly createNetwork: (name: string) => Promise<Network>;
  readonly deleteNetwork: (name: string) => Promise<void>;
  readonly joinNetwork: (network: string, imp: string) => Promise<NetworkJoin>;
  readonly leaveNetwork: (network: string, imp: string) => Promise<Network>;

  // a trust warning for each network the imp is on that mixes open imps
  // with box or none ones; NOT_FOUND for no such imp
  readonly readTrustWarnings: (imp: string) => Promise<string[]>;

  // a new imp's networks; NOT_FOUND for one that does not exist
  readonly resolveNetworkIds: (names: readonly string[]) => Promise<string[]>;

  // a restored imp's networks, made under the firewall's lock when missing;
  // `created` names the ones made, for removeEmptyNetworks after a failure
  readonly writeMissingNetworks: (
    names: readonly string[],
  ) => Promise<{ readonly ids: readonly string[]; readonly created: readonly string[] }>;

  // the named networks that have no members left
  readonly removeEmptyNetworks: (names: readonly string[]) => Promise<void>;
}

export function createNetworkService(deps: NetworkDeps): NetworkService {
  const db = deps.db;

  const requireNetwork = async (name: string): Promise<NetworkRecord> => {
    const network = await findNetworkByName(db, name);

    if (network === undefined) {
      throw buildNotFoundError('network', name);
    }

    return network;
  };

  const requireImpId = async (name: string): Promise<string> => {
    const imp = await findImpByName(db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp.id;
  };

  // inside the lock: nothing else makes networks meanwhile
  const requireWritten = async (name: string): Promise<NetworkRecord> => {
    const network = await writeNetwork(db, name);

    if (network === null) {
      throw buildConflictError('network', name);
    }

    return network;
  };

  const removeEmpty = async (names: readonly string[]): Promise<void> => {
    for (const name of names) {
      const network = await findNetworkByName(db, name);

      if (network !== undefined && network.imps.length === 0) {
        await removeNetwork(db, network.id);
      }
    }
  };

  // An open member reaches anything, and can relay for a box or none one:
  // a network is a trust boundary. Null when the network mixes no policies.
  const readTrustWarning = async (networkName: string, impName: string): Promise<string | null> => {
    const network = await requireNetwork(networkName);
    const slots = await listEgressSlots(db);

    const modes = new Map(slots.map((slot) => [slot.name, slot.policy.mode]));

    const others = network.imps.filter((name) => name !== impName);
    const open = others.filter((name) => modes.get(name) === 'open');
    const closed = others.filter((name) => modes.get(name) !== 'open');
    const mode = modes.get(impName);

    if (mode !== 'open' && open.length > 0) {
      return `${impName} is ${String(mode)}, but ${open.join(', ')} on ${networkName} ${open.length === 1 ? 'is' : 'are'} open and can relay for it: a box or none imp trusts its open peers`;
    }

    if (mode === 'open' && closed.length > 0) {
      return `${impName} is open, so ${closed.join(', ')} on ${networkName} can reach anything through it: a box or none imp trusts its open peers`;
    }

    return null;
  };

  const readNetwork = async (name: string): Promise<Network> => {
    const network = await requireNetwork(name);

    return toApiNetwork(network);
  };

  return {
    listNetworks: async () => {
      const networks = await listNetworks(db);

      return networks.map((network) => toApiNetwork(network));
    },

    // through the lock, so the resolver knows the name at once
    createNetwork: async (name) => {
      const network = await deps.egress.changeNetworks({
        write: () => writeNetwork(db, name),
        undo: async (created) => {
          if (created !== null) {
            await removeNetwork(db, created.id);
          }
        },
      });

      if (network === null) {
        throw buildConflictError('network', name);
      }

      return toApiNetwork(network);
    },

    // the members are read under the lock, so a join just before is put
    // back with the rest
    deleteNetwork: async (name) => {
      const network = await requireNetwork(name);

      await deps.egress.changeNetworks({
        write: async () => {
          const members = await listNetworkMembers(db);

          await removeNetwork(db, network.id);

          return members.filter((member) => member.network === name).map((member) => member.impId);
        },
        undo: (impIds) => writeNetworkWithMembers(db, network, impIds),
      });
    },

    joinNetwork: async (networkName, impName) => {
      const network = await requireNetwork(networkName);

      // under the imp's lock, which refuses a marked imp with MOVING: a join
      // cannot slip in after a warm move's network check
      await deps.imps.lockImp(impName, (imp) =>
        deps.egress.changeNetworks({
          write: () => writeMember(db, network.id, imp.id),
          undo: async (added) => {
            if (added) {
              await removeMember(db, network.id, imp.id);
            }
          },
        }),
      );

      const joined = await readNetwork(networkName);
      const warning = await readTrustWarning(networkName, impName);

      return { ...joined, warning };
    },

    leaveNetwork: async (networkName, impName) => {
      const network = await requireNetwork(networkName);
      const impId = await requireImpId(impName);

      await deps.egress.changeNetworks({
        write: () => removeMember(db, network.id, impId),
        undo: async (removed) => {
          if (removed) {
            await writeMember(db, network.id, impId);
          }
        },
      });

      return readNetwork(networkName);
    },

    readTrustWarnings: async (impName) => {
      await requireImpId(impName);

      const networks = await listNetworks(db);

      const warnings: string[] = [];

      for (const network of networks.filter((each) => each.imps.includes(impName))) {
        const warning = await readTrustWarning(network.name, impName);

        if (warning !== null) {
          warnings.push(warning);
        }
      }

      return warnings;
    },

    resolveNetworkIds: async (names) => {
      const ids: string[] = [];

      for (const name of new Set(names)) {
        const network = await requireNetwork(name);

        ids.push(network.id);
      }

      return ids;
    },

    writeMissingNetworks: (names) =>
      deps.egress.changeNetworks({
        write: async () => {
          const ids: string[] = [];
          const created: string[] = [];

          for (const name of new Set(names)) {
            const found = await findNetworkByName(db, name);

            if (found !== undefined) {
              ids.push(found.id);
              continue;
            }

            const network = await requireWritten(name);

            ids.push(network.id);
            created.push(name);
          }

          return { ids, created };
        },
        undo: (written) => removeEmpty(written.created),
      }),

    removeEmptyNetworks: async (names) => {
      await deps.egress.changeNetworks({ write: () => removeEmpty(names), undo: async () => {} });
    },
  };
}

function toApiNetwork(network: Readonly<NetworkRecord>): Network {
  return { name: network.name, imps: network.imps, createdAt: network.createdAt };
}
