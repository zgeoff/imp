import * as z from 'zod';
import type { SleepSpan } from './budget-overshoot';
import { startImp } from './imp-cli';

const SleptEventSchema = z.object({
  ev: z.literal('ImpChanged'),
  reason: z.literal('slept'),
  at: z.iso.datetime(),
  detail: z.object({ durationMs: z.int().nonnegative() }),
});

// an `imp events` line as a sleep, from the event's own time less the length
// impd measured; null for every other event
export function parseSleepSpan(line: string): SleepSpan | null {
  const event = SleptEventSchema.safeParse(JSON.parse(line));

  if (!event.success) {
    return null;
  }

  const endAt = Date.parse(event.data.at);

  return { startAt: endAt - event.data.detail.durationMs, endAt };
}

export interface SleepWatch {
  readonly sleeps: readonly SleepSpan[];
  readonly stop: () => Promise<void>;
}

// follows `imp events` and keeps every imp's sleep
export async function startSleepWatch(): Promise<SleepWatch> {
  const events = await startImp(['events']);

  const sleeps: SleepSpan[] = [];

  const reading = (async () => {
    const decoder = new TextDecoder();

    let buffered = '';

    for await (const chunk of events.stdout) {
      buffered += decoder.decode(chunk, { stream: true });

      const lines = buffered.split('\n');

      buffered = lines.pop() ?? '';

      for (const line of lines) {
        const sleep = parseSleepSpan(line);

        if (sleep !== null) {
          sleeps.push(sleep);
        }
      }
    }
  })();

  return {
    sleeps,
    stop: async () => {
      events.kill();

      await reading;
    },
  };
}
