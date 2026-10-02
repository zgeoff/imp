import type { Network } from '@imp/api';
import { buildConflictError, buildNotFoundError } from '../api-errors';
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

// Private networks between imps (docs/guides/networks.md). Every change to
// who is on a network goes through the egress firewall's lock, which builds
// the table from these rows.

export interface NetworkDeps {
  readonly db: ImpDatabase;
  readonly egress: Pick<EgressService, 'changeNetworks'>;
}

export interface NetworkService {
  readonly listNetworks: () => Promise<Network[]>;
  readonly createNetwork: (name: string) => Promise<Network>;
  readonly deleteNetwork: (name: string) => Promise<void>;
  readonly joinNetwork: (network: string, imp: string) => Promise<Network>;
  readonly leaveNetwork: (network: string, imp: string) => Promise<Network>;

  // a new imp's networks: NOT_FOUND for one that does not exist, or with
  // `createMissing`, as a restore does, a new one
  readonly resolveNetworkIds: (
    names: readonly string[],
    createMissing?: boolean,
  ) => Promise<string[]>;
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

  const resolveNetwork = async (name: string, createMissing: boolean): Promise<NetworkRecord> => {
    const found = await findNetworkByName(db, name);

    if (found !== undefined) {
      return found;
    }

    if (!createMissing) {
      throw buildNotFoundError('network', name);
    }

    const created = await writeNetwork(db, name);

    // null: another call made it since the lookup
    return created ?? requireNetwork(name);
  };

  const requireImpId = async (name: string): Promise<string> => {
    const imp = await findImpByName(db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return imp.id;
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

    createNetwork: async (name) => {
      const network = await writeNetwork(db, name);

      if (network === null) {
        throw buildConflictError('network', name);
      }

      return toApiNetwork(network);
    },

    deleteNetwork: async (name) => {
      const network = await requireNetwork(name);
      const members = await listNetworkMembers(db);

      const impIds = members
        .filter((member) => member.network === name)
        .map((member) => member.impId);

      await deps.egress.changeNetworks({
        write: () => removeNetwork(db, network.id),
        undo: () => writeNetworkWithMembers(db, network, impIds),
      });
    },

    joinNetwork: async (networkName, impName) => {
      const network = await requireNetwork(networkName);
      const impId = await requireImpId(impName);

      await deps.egress.changeNetworks({
        write: () => writeMember(db, network.id, impId),
        undo: async (added) => {
          if (added) {
            await removeMember(db, network.id, impId);
          }
        },
      });

      return readNetwork(networkName);
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

    resolveNetworkIds: async (names, createMissing = false) => {
      const ids: string[] = [];

      for (const name of new Set(names)) {
        const network = await resolveNetwork(name, createMissing);

        ids.push(network.id);
      }

      return ids;
    },
  };
}

function toApiNetwork(network: Readonly<NetworkRecord>): Network {
  return { name: network.name, imps: network.imps, createdAt: network.createdAt };
}
