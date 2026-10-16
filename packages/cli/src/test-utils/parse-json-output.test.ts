import { expect, test } from 'bun:test';
import { parseJsonOutput } from './parse-json-output';

test('it accepts output that the committed schema describes', () => {
  const printed = {
    path: '/data/db-copies/before-upgrade.sqlite',
    sizeBytes: 4096,
    lastMigration: '0042_imp_phase',
    impVersion: '2.1.0',
    createdAt: '2026-10-16T09:30:00.000Z',
    integrity: 'ok',
  };

  const result = parseJsonOutput('db copy', JSON.stringify(printed));

  expect(result.data).toStrictEqual(printed);
});

test('it rejects output without a field that the committed schema requires', () => {
  const printed = {
    path: '/data/db-copies/before-upgrade.sqlite',
    sizeBytes: 4096,
    lastMigration: '0042_imp_phase',
    createdAt: '2026-10-16T09:30:00.000Z',
    integrity: 'ok',
  };

  const result = parseJsonOutput('db copy', JSON.stringify(printed));

  expect(result.error?.issues).toPartiallyContain({ path: ['impVersion'] });
});

test('it rejects output with a field that the committed schema does not name', () => {
  const printed = {
    path: '/data/db-copies/before-upgrade.sqlite',
    sizeBytes: 4096,
    lastMigration: '0042_imp_phase',
    impVersion: '2.1.0',
    createdAt: '2026-10-16T09:30:00.000Z',
    integrity: 'ok',
    version: '2.1.0',
  };

  const result = parseJsonOutput('db copy', JSON.stringify(printed));

  expect(result.error?.issues).toPartiallyContain({ code: 'unrecognized_keys', keys: ['version'] });
});

test('it throws for a command with no committed schema', () => {
  expect(() => parseJsonOutput('token ls', '[]')).toThrowWithMessage(
    Error,
    'no committed schema for impz token ls --json',
  );
});
