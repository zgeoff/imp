import { EVENT_VERSION } from '@imp/api';
import type { Imp, ImpEvent } from '@imp/api';
import { toApiCheckpoint } from '../db/checkpoints';
import { subscribeImpWrites } from '../db/imp-write-feed';
import type { ImpWrite } from '../db/imp-write-feed';
import { findImpById } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { readErrorMessage } from '../read-error-message';
import type { EventBus } from './event-bus';

interface PublisherDeps {
  readonly db: ImpDatabase;
  readonly bus: EventBus;
  readonly toApi: (imp: ImpRecord) => Promise<Imp>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

// Turns each write the database reports into an event in the API's shape.
// The shape takes a lookup, so one loop drains the writes: events leave in
// the order the writes landed. Returns the stop.
export function startImpEventPublisher(deps: PublisherDeps): () => void {
  const pending: ImpWrite[] = [];
  const state = { draining: false };

  const drain = async (): Promise<void> => {
    state.draining = true;

    for (let write = pending.shift(); write !== undefined; write = pending.shift()) {
      try {
        const event = await buildEvent(deps, write);

        if (event !== null) {
          deps.bus.publish(event);
        }
      } catch (error) {
        deps.log(`impd: events: ${readErrorMessage(error)}`);
      }
    }

    state.draining = false;
  };

  return subscribeImpWrites(deps.db, (write) => {
    pending.push(write);

    if (!state.draining) {
      void drain();
    }
  });
}

async function buildEvent(
  deps: PublisherDeps,
  write: Readonly<ImpWrite>,
): Promise<ImpEvent | null> {
  const envelope = { v: EVENT_VERSION, at: new Date(deps.now()) } as const;

  switch (write.kind) {
    case 'added': {
      return { ...envelope, ev: 'ImpAdded', reason: 'created', imp: await deps.toApi(write.imp) };
    }
    case 'changed': {
      return {
        ...envelope,
        ev: 'ImpChanged',
        reason: write.reason,
        imp: await deps.toApi(write.imp),
        ...(write.detail !== undefined && { detail: write.detail }),
      };
    }
    case 'removed': {
      return { ...envelope, ev: 'ImpRemoved', imp: await deps.toApi(write.imp) };
    }
    case 'checkpointAdded':
    case 'checkpointRemoved': {
      const imp = await findImpById(deps.db, write.checkpoint.impId);

      if (imp === undefined) {
        return null;
      }

      const ev = write.kind === 'checkpointAdded' ? 'CheckpointAdded' : 'CheckpointRemoved';

      return { ...envelope, ev, name: imp.name, checkpoint: toApiCheckpoint(write.checkpoint) };
    }
    default: {
      return null;
    }
  }
}
