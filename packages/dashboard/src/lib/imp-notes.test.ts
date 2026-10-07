import { expect, test } from 'bun:test';
import { buildMockImp } from '../test-utils/build-mock-imp';
import { buildImpNotes } from './imp-notes';

test('it gives a healthy imp no notes', () => {
  const imp = buildMockImp({ name: 'web', state: 'running' });

  expect(buildImpNotes(imp, Date.parse('2026-10-02T12:00:00Z'))).toStrictEqual([]);
});

test('it explains an error, a hold, a cold next wake and outdated parts in that order', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');

  const imp = buildMockImp({
    name: 'web',
    state: 'sleeping',
    error: 'boot failed',
    coldBootReason: 'firecracker changed',
    outdated: ['kernel', 'agent'],
    holdUntil: new Date(now + 300_000),
  });

  expect(buildImpNotes(imp, now)).toStrictEqual([
    { tone: 'error', text: 'boot failed' },
    { tone: 'info', text: 'held awake, ends in 5m' },
    { tone: 'warning', text: 'next wake boots cold: firecracker changed' },
    { tone: 'warning', text: 'runs an older kernel, agent' },
  ]);
});

test('it tells why the last boot of an awake imp was cold', () => {
  const imp = buildMockImp({ name: 'web', state: 'running', coldBootReason: 'no snapshot' });

  expect(buildImpNotes(imp, Date.parse('2026-10-02T12:00:00Z'))).toStrictEqual([
    { tone: 'info', text: 'last boot was cold: no snapshot' },
  ]);
});

test('it leaves out a hold that has ended', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const imp = buildMockImp({ name: 'web', state: 'running', holdUntil: new Date(now - 1000) });

  expect(buildImpNotes(imp, now)).toStrictEqual([]);
});

test('it says since when the agent of an imp stopped answering', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const imp = buildMockImp({ name: 'web', agentSilentSince: new Date(now - 120_000) });

  expect(buildImpNotes(imp, now)).toStrictEqual([
    { tone: 'warning', text: 'agent not answering since 2m ago' },
  ]);
});

test('it says an imp has no IPv6 until its next cold boot', () => {
  const imp = buildMockImp({ name: 'web', outdated: ['ipv6'] });

  expect(buildImpNotes(imp, Date.parse('2026-10-02T12:00:00Z'))).toStrictEqual([
    { tone: 'info', text: 'no IPv6 until its next cold boot' },
  ]);
});

test('it keeps ipv6 out of the outdated parts it lists', () => {
  const imp = buildMockImp({ name: 'web', outdated: ['kernel', 'ipv6'] });

  expect(buildImpNotes(imp, Date.parse('2026-10-02T12:00:00Z'))).toStrictEqual([
    { tone: 'warning', text: 'runs an older kernel' },
    { tone: 'info', text: 'no IPv6 until its next cold boot' },
  ]);
});
