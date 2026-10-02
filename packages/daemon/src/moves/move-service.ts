import { ORPCError } from '@orpc/server';
import type { Config } from '../config';
import { createMoveReceiver } from './move-receiver';
import type { MoveReceiver, MoveReceiverDeps } from './move-receiver';
import { createMoveSender } from './move-sender';
import type { MoveSender, MoveSenderDeps } from './move-sender';
import { createPeerRanges } from './peer-address';

// Moves between hosts (docs/architecture/moves.md): this host as a source,
// its sender, and as a target, its receiver
export type MoveService = MoveSender &
  Pick<MoveReceiver, 'issueTicket' | 'reissueTicket' | 'handle'> & {
    readonly recover: () => Promise<void>;
  };

type SharedKeys = 'storage' | 'imps' | 'grants';

export interface MoveServiceDeps
  extends
    Omit<MoveSenderDeps, 'ranges' | SharedKeys>,
    Omit<MoveReceiverDeps, 'ranges' | 'readPeerUrl' | SharedKeys> {
  readonly config: Pick<Config, 'apiPort' | 'moves'>;
  readonly storage: MoveSenderDeps['storage'] & MoveReceiverDeps['storage'];
  readonly imps: MoveSenderDeps['imps'] & MoveReceiverDeps['imps'];
  readonly grants: MoveSenderDeps['grants'] & MoveReceiverDeps['grants'];

  // the tailnet IP, for a peer URL when IMP_PEER_URL is unset
  readonly readTailnetIp: () => Promise<string | null>;
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

  const sender = createMoveSender({ ...deps, ranges });
  const receiver = createMoveReceiver({ ...deps, ranges, readPeerUrl });

  return {
    ...sender,
    issueTicket: receiver.issueTicket,
    reissueTicket: receiver.reissueTicket,
    handle: receiver.handle,
    recover: async () => {
      await receiver.recover();
      await sender.recover();
    },
  };
}
