import { expect, test } from 'bun:test';
import { EVENT_VERSION } from '@imp/api';
import type { ImpEvent } from '@imp/api';
import { ORPCError } from '@orpc/client';
import { printEvents } from './events';
import type { EventSource } from './events';

const AT = new Date('2026-10-02T12:00:00Z');

function buildDecision(name: string): ImpEvent {
  return {
    v: EVENT_VERSION,
    at: AT,
    ev: 'GovernorDecision',
    decision: 'admitted',
    name,
    trigger: 'admission',
    usedMib: 0,
    budgetMib: 1024,
  };
}

// a stream that sends `events`, then ends as impd ends one
async function* buildEventStream(events: readonly ImpEvent[]): AsyncGenerator<ImpEvent> {
  for (const event of events) {
    yield await Promise.resolve(event);
  }
}

const CHECK = { clientVersion: '0.3.0', serverVersion: '0.2.2', compatible: false };

interface ScriptedStream {
  readonly names?: readonly string[];
  readonly failure?: Error;

  // how long the stream lasts, on the fake clock
  readonly lastsMs?: number;
}

// an EventSource that plays `streams` in turn on a fake clock, and records
// each backoff
function buildSource(script: readonly ScriptedStream[]) {
  const streams = [...script];
  const clock = { now: 0 };
  const backoffs: number[] = [];
  const warnings: string[] = [];

  const source: EventSource = {
    openStream: () => {
      const next = streams.shift() ?? {};

      clock.now += next.lastsMs ?? 0;

      if (next.failure !== undefined) {
        return Promise.reject(next.failure);
      }

      const events = (next.names ?? []).map((name) => buildDecision(name));

      return Promise.resolve(buildEventStream(events));
    },
    checkServer: () => Promise.resolve(CHECK),
    now: () => clock.now,
    wait: (ms) => {
      backoffs.push(ms);

      return Promise.resolve();
    },
    warn: (line) => {
      warnings.push(line);
    },
  };

  return { source, backoffs, warnings };
}

test('it prints one JSON line an event and reconnects after an end or a network drop', async () => {
  const lines: string[] = [];

  const scripted = buildSource([
    { names: ['dev', 'web'] },
    { failure: new TypeError('fetch failed') },
    { names: ['dev'] },
  ]);

  const failure = await printEvents(scripted.source, 'dev', (line) => {
    lines.push(line);
  }).catch((error: unknown) => error);

  expect(String(failure)).toContain('the event stream ended 5 times in a row');
  expect(scripted.backoffs).toEqual([1000, 2000, 4000, 8000]);
  expect(scripted.warnings[1]).toContain('fetch failed');

  expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
    { ...buildDecision('dev'), at: AT.toISOString() },
    { ...buildDecision('dev'), at: AT.toISOString() },
  ]);
});

test('a stream that lasted starts the count and the backoff again', async () => {
  const scripted = buildSource([{}, {}, { lastsMs: 20_000 }]);

  const failure = await printEvents(scripted.source, null, () => {}).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
  expect(scripted.backoffs).toEqual([1000, 2000, 1000, 2000, 4000, 8000]);
});

test('an impd from before the stream says to upgrade it, and a 401 is not retried', async () => {
  const old = buildSource([{ failure: new ORPCError('NOT_FOUND', { status: 404 }) }]);

  const outdated = await printEvents(old.source, null, () => {}).catch((error: unknown) => error);

  expect(String(outdated)).toContain('impd 0.2.2 has no event stream; upgrade it to 0.3.0');

  const refused = buildSource([{ failure: new ORPCError('UNAUTHORIZED', { status: 401 }) }]);

  const unauthorized = await printEvents(refused.source, null, () => {}).catch(
    (error: unknown) => error,
  );

  expect(unauthorized).toBeInstanceOf(ORPCError);
  expect(refused.backoffs).toEqual([]);
});
