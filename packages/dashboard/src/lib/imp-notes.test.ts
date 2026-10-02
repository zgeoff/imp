import { expect, test } from 'bun:test';
import { buildImp } from '../test-utils/fake-impd';
import { buildImpNotes } from './imp-notes';

const NOW = Date.parse('2026-10-02T12:00:00Z');

test('a healthy imp has no notes', () => {
  expect(buildImpNotes(buildImp({ name: 'web' }), NOW)).toEqual([]);
});

test('it explains errors, cold boots, outdated parts and holds', () => {
  const imp = buildImp({
    name: 'web',
    state: 'sleeping',
    error: 'boot failed',
    coldBootReason: 'firecracker changed',
    outdated: ['kernel', 'agent'],
    holdUntil: new Date(NOW + 300_000),
  });

  expect(buildImpNotes(imp, NOW)).toEqual([
    { tone: 'error', text: 'boot failed' },
    { tone: 'info', text: 'held awake, ends in 5m' },
    { tone: 'warning', text: 'next wake boots cold: firecracker changed' },
    { tone: 'warning', text: 'runs an older kernel, agent' },
  ]);
});

test('an awake imp tells why its last boot was cold, and a past hold is gone', () => {
  const imp = buildImp({
    name: 'web',
    coldBootReason: 'no snapshot',
    holdUntil: new Date(NOW - 1000),
  });

  expect(buildImpNotes(imp, NOW)).toEqual([
    { tone: 'info', text: 'last boot was cold: no snapshot' },
  ]);
});

test('an imp whose agent stopped answering says since when', () => {
  const imp = buildImp({ name: 'web', agentSilentSince: new Date(NOW - 120_000) });

  expect(buildImpNotes(imp, NOW)).toEqual([
    { tone: 'warning', text: 'agent not answering since 2m ago' },
  ]);
});
