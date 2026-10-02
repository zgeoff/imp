import type { WarmHost } from '@imp/api';
import { ORPCError } from '@orpc/server';
import type { Broker } from '../broker/broker-service';
import type { Config } from '../config';
import { subscribeImpWrites } from '../db/imp-write-feed';
import { claimTrustPending } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import { readErrorMessage } from '../read-error-message';
import { createMoveReceiver } from './move-receiver';
import type { MoveReceiver, MoveReceiverDeps } from './move-receiver';
import { createMoveSender } from './move-sender';
import type { MoveSender, MoveSenderDeps } from './move-sender';
import { createPeerRanges } from './peer-address';
import { readWarmHost } from './warm-facts';

// Moves between hosts (docs/architecture/moves.md): this host as a source,
// its sender, and as a target, its receiver
export type MoveService = MoveSender &
  Pick<MoveReceiver, 'issueTicket' | 'reissueTicket' | 'handle'> & {
    readonly recover: () => Promise<void>;

    // what a warm move to this host must match
    readonly readFacts: () => WarmHost;
  };

type SharedKeys = 'storage' | 'imps' | 'grants' | 'egress' | 'readWarmHost';

export interface MoveServiceDeps
  extends
    Omit<MoveSenderDeps, 'ranges' | SharedKeys>,
    Omit<MoveReceiverDeps, 'ranges' | 'readPeerUrl' | SharedKeys> {
  readonly config: Pick<Config, 'apiPort' | 'moves' | 'dataDir' | 'subnet' | 'brokerPort' | 'dns'>;
  readonly storage: MoveSenderDeps['storage'] & MoveReceiverDeps['storage'];
  readonly imps: MoveSenderDeps['imps'] & MoveReceiverDeps['imps'];

  // and, for a warm-moved imp's first wake, the broker's CA install
  readonly grants: MoveSenderDeps['grants'] &
    MoveReceiverDeps['grants'] &
    Pick<Broker, 'readExecEnv'>;
  readonly egress: MoveSenderDeps['egress'] & MoveReceiverDeps['egress'];

  // the tailnet IP, for a peer URL when IMP_PEER_URL is unset
  readonly readTailnetIp: () => Promise<string | null>;

  // tests only: two impds in one process cannot share a data dir, which a
  // warm move must match, so a test hands both hosts the same facts
  readonly readWarmHost?: () => WarmHost;
}

export function createMoveService(deps: MoveServiceDeps): MoveService {
  const ranges = createPeerRanges(deps.config.moves.testCidr);

  if (ranges.testCidr !== null) {
    deps.log(
      `impd: warning: IMP_E2E=1 and IMP_MOVE_TEST_CIDR open moves to ${ranges.testCidr}, off the tailnet`,
    );
  }

  const readPeerUrl = async (): Promise<string> => {
    if (deps.config.moves.peerUrl !== null) {
      return deps.config.moves.peerUrl;
    }

    const ip = await deps.readTailnetIp();

    if (ip === null) {
      throw new ORPCError('PRECONDITION_FAILED', {
        message:
          'this host is not on the tailnet, and IMP_PEER_URL is unset: it cannot receive moves',
      });
    }

    return `http://${ip}:${String(deps.config.apiPort)}`;
  };

  const readWarm =
    deps.readWarmHost ?? (() => readWarmHost(deps.config, deps.readIdentity(), deps.storage.kind));

  const sender = createMoveSender({ ...deps, ranges, readWarmHost: readWarm });
  const receiver = createMoveReceiver({ ...deps, ranges, readPeerUrl, readWarmHost: readWarm });

  // The first wake after a warm move installs this host's broker CA in the
  // guest at once, not at its first exec: until then the guest trusts the
  // source's (docs/architecture/moves.md#warm-moves)
  const applyPendingTrust = async (imp: ImpRecord): Promise<void> => {
    try {
      const isPending = await claimTrustPending(deps.db, imp.id);

      if (isPending) {
        await deps.grants.readExecEnv(imp, deps.storage.resolveImpPaths(imp.id).vsockSocket);
      }
    } catch (error) {
      deps.log(`impd: move: ${imp.name}: broker CA after the wake: ${readErrorMessage(error)}`);
    }
  };

  subscribeImpWrites(deps.db, (write) => {
    if (write.kind === 'changed' && write.reason === 'woke' && write.imp.isTrustPending) {
      void applyPendingTrust(write.imp);
    }
  });

  return {
    ...sender,
    issueTicket: receiver.issueTicket,
    reissueTicket: receiver.reissueTicket,
    handle: receiver.handle,
    readFacts: readWarm,
    recover: async () => {
      await receiver.recover();
      await sender.recover();
    },
  };
}
