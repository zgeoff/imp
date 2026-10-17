import type { ImpEvent } from '@impz/client';
import { watchEvents } from '@impz/client';
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

    // a 401 ends the watch; any other end opens a fresh stream
    const watchUntilUnmounted = async (): Promise<void> => {
      try {
        await watchEvents(impd.client, {
          signal,
          reconnect: { delayMs: RECONNECT_MS, shouldRetry: (error) => !isUnauthorized(error) },
          onOpen: async (attempt) => {
            // what this browser missed while it was away
            if (attempt > 1) {
              await queryClient.invalidateQueries();
            }
          },
          onEvent: applyEvent,
        });
      } catch {
        // the queries' own 401 sends the browser to the login page
      }
    };

    void watchUntilUnmounted();

    return () => {
      controller.abort();
    };
  }, [impd, queryClient]);
}
