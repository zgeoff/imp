import type { ImpEvent } from '@imp/api';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { isUnauthorized } from './build-query-client';
import { useImpd } from './impd';

// how long the dashboard waits before it opens a stream that ended again
const RECONNECT_MS = 2000;

// Follows impd's event stream while the app is open: each event marks the
// queries it touches stale, so a view changes as impd does, not on a clock.
// A 401 stops it: the queries' own 401 sends the browser to the login page.
export function useImpdEvents(): void {
  const impd = useImpd();
  const queryClient = useQueryClient();

  useEffect(() => {
    const controller = new AbortController();

    const signal = controller.signal;

    const applyEvent = async (event: Readonly<ImpEvent>): Promise<void> => {
      // an exec in an imp's agent changes nothing the dashboard shows
      if ((event.ev === 'ImpAdded' && event.reason === 'snapshot') || event.ev === 'AgentExec') {
        return;
      }

      if (event.ev === 'CheckpointAdded' || event.ev === 'CheckpointRemoved') {
        await queryClient.invalidateQueries({ queryKey: impd.query.checkpoints.key() });

        return;
      }

      if (event.ev !== 'GovernorDecision') {
        await queryClient.invalidateQueries({ queryKey: impd.query.imps.key() });
      }

      await queryClient.invalidateQueries({ queryKey: impd.query.system.key() });
    };

    const readEvents = async (): Promise<void> => {
      for (let attempt = 0; !signal.aborted; attempt += 1) {
        try {
          const events = await impd.client.events.stream(undefined, { signal });

          // what this browser missed while it was away
          if (attempt > 0) {
            await queryClient.invalidateQueries();
          }

          for await (const event of events) {
            await applyEvent(event);
          }
        } catch (error) {
          if (signal.aborted || isUnauthorized(error)) {
            return;
          }
        }

        await waitUnlessAborted(RECONNECT_MS, signal);
      }
    };

    void readEvents();

    return () => {
      controller.abort();
    };
  }, [impd, queryClient]);
}

async function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  const waiting = Promise.withResolvers<undefined>();

  const timer = setTimeout(() => {
    waiting.resolve(undefined);
  }, ms);

  const stopWaiting = (): void => {
    clearTimeout(timer);

    waiting.resolve(undefined);
  };

  signal.addEventListener('abort', stopWaiting, { once: true });

  await waiting.promise;

  signal.removeEventListener('abort', stopWaiting);
}
