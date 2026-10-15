import { expect, test } from 'bun:test';
import { collectEventLines, formatEventLine } from './event-lines';

test('#formatEventLine names the imp, the event and its reason', () => {
  const line = JSON.stringify({
    ev: 'ImpChanged',
    reason: 'booted',
    imp: { name: 'e2e-life-ev', state: 'running' },
  });

  expect(formatEventLine(line)).toBe('e2e-life-ev ImpChanged booted');
});

test('#formatEventLine ends a snapshot line with the state', () => {
  const line = JSON.stringify({
    ev: 'ImpAdded',
    reason: 'snapshot',
    imp: { name: 'e2e-life-anchor', state: 'running' },
  });

  expect(formatEventLine(line)).toBe('e2e-life-anchor ImpAdded snapshot running');
});

test('#formatEventLine names a removed imp by its name field', () => {
  expect(formatEventLine('{"ev":"ImpRemoved","name":"e2e-life-ev"}')).toBe(
    'e2e-life-ev ImpRemoved',
  );
});

test('#formatEventLine leaves out a governor decision', () => {
  expect(formatEventLine('{"ev":"GovernorDecision","reason":"sleep"}')).toBeNull();
});

test('#collectEventLines passes each whole line once, across chunks that split them', async () => {
  const encoder = new TextEncoder();

  const chunks = [
    '{"ev":"ImpRemoved","na',
    'me":"a"}\n{"ev":"GovernorDecision"}\n{"ev":"ImpRemoved",',
    '"name":"b"}\n',
  ];

  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }

      controller.close();
    },
  });

  const seen: string[] = [];

  await collectEventLines(stdout, (line) => {
    seen.push(line);
  });

  expect(seen).toStrictEqual(['a ImpRemoved', 'b ImpRemoved']);
});
