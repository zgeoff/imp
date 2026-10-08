import type { Imp, ImpEvent } from '@imp/api';
import { EVENT_VERSION, isImpAllowed } from '@imp/api';
import { createLogouts } from '@imp/daemon/src/auth/logouts';
import type { EventBus } from '@imp/daemon/src/events/event-bus';
import { openEventStream } from '@imp/daemon/src/events/event-stream';

type ImpdEventListener = (event: Readonly<ImpEvent>) => void;

// what an event stream runs for: the session's imp patterns and expiry
interface StreamSession {
  readonly imps: readonly string[] | null;
  readonly expiresAt: Date;
}

// The subscribers of the mock impd's event bus, one per open stream; the
// preload clears it after each test
export const impdEventListeners = new Set<ImpdEventListener>();

const impdEventBus: EventBus = {
  publish: (event) => {
    for (const listener of impdEventListeners) {
      listener(event);
    }
  },
  subscribe: (listener) => {
    impdEventListeners.add(listener);

    return () => {
      impdEventListeners.delete(listener);
    };
  },
};

// impd's own logouts (packages/daemon auth/logouts.ts): a logout ends every
// dashboard stream
export const impdLogouts = createLogouts();

// sends an event to every open stream, as impd does after a change
export function emitImpdEvent(event: ImpEvent): void {
  impdEventBus.publish(event);
}

// events.stream through impd's own openEventStream, filtered and ended as
// packages/daemon build-router.ts does: by the session's imp patterns, and
// at the caller's abort, a logout, or the session's expiry
export function openImpdEventStream(
  session: StreamSession,
  readImps: () => readonly Imp[],
  signal: AbortSignal | undefined,
): AsyncGenerator<ImpEvent> {
  const ends = impdLogouts.readSignal();
  const stops = signal === undefined ? ends : AbortSignal.any([signal, ends]);

  return openEventStream({
    bus: impdEventBus,
    readSnapshot: () => {
      const at = new Date();

      return Promise.resolve(
        readImps()
          .filter((imp) => isImpAllowed(session.imps, imp.name))
          .map((imp) => ({
            v: EVENT_VERSION,
            at,
            ev: 'ImpAdded' as const,
            reason: 'snapshot' as const,
            imp,
          })),
      );
    },
    signal: stops,
    endsAt: session.expiresAt.getTime(),
    now: Date.now,
    accepts: (event) => {
      const name = 'imp' in event ? event.imp.name : event.name;

      return isImpAllowed(session.imps, name);
    },
  });
}
