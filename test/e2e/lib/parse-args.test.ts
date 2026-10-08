import { expect, test } from 'bun:test';
import { parseArgs } from './parse-args';

test('it runs every suite in run order when no suite is named', () => {
  expect(parseArgs([]).suites).toStrictEqual([
    'lifecycle',
    'docker',
    'images',
    'registry',
    'checkpoints',
    'disks',
    'sleep',
    'scale',
    'restart',
    'tailscale',
    'mcp',
    'mcp-oauth',
    'sessions',
    'offsets',
    'session-logs',
    'services',
    'ssh',
    'ssh-wake',
    'ssh-agent',
    'reverse',
    'proxy',
    'proxy-wake',
    'cp',
    'connectors',
    'dashboard',
    'https',
    'tokens',
    'leases',
    'egress',
    'ipv6',
    'networks',
    'cpu',
    'templates',
    'boot-templates',
    'inner',
    'socket',
    'moves',
    'moves-tailnet',
    'chaos',
    'jail',
    'memory',
    'ksm',
    'backups',
  ]);
});

test('it treats a run with no suite named as the acceptance run', () => {
  expect(parseArgs([]).acceptance).toBeTrue();
});

test('it runs named suites in run order, not the order given', () => {
  expect(parseArgs(['--only', 'restart,checkpoints']).suites).toStrictEqual([
    'checkpoints',
    'restart',
  ]);
});

test('it treats named suites as short of the acceptance run', () => {
  expect(parseArgs(['--only', 'restart,checkpoints']).acceptance).toBeFalse();
});

test('it expands a set and drops a suite the set already holds', () => {
  expect(parseArgs(['--only', 'fast,sleep']).suites).toStrictEqual([
    'lifecycle',
    'registry',
    'checkpoints',
    'disks',
    'sleep',
    'restart',
    'mcp',
    'offsets',
    'session-logs',
    'services',
    'ssh',
    'ssh-agent',
    'reverse',
    'proxy',
    'dashboard',
    'tokens',
    'leases',
    'cpu',
    'templates',
    'boot-templates',
    'inner',
    'socket',
    'jail',
    'memory',
    'ksm',
  ]);
});

test('it treats an explicit acceptance set as the acceptance run', () => {
  expect(parseArgs(['--only', 'acceptance']).acceptance).toBeTrue();
});

test.each([
  [
    '1',
    [
      'lifecycle',
      'registry',
      'checkpoints',
      'disks',
      'restart',
      'offsets',
      'session-logs',
      'services',
      'ssh',
      'ssh-agent',
      'proxy',
      'dashboard',
      'tokens',
      'leases',
      'cpu',
      'templates',
      'boot-templates',
      'socket',
    ],
  ],
  ['2', ['sleep', 'reverse', 'jail']],
  ['3', ['mcp', 'inner', 'memory', 'ksm']],
])('it runs fast group %s with --group', (group, suites) => {
  expect(parseArgs(['--group', group]).suites).toStrictEqual(suites);
});

test('it treats a fast group as short of the acceptance run', () => {
  expect(parseArgs(['--group', '2']).acceptance).toBeFalse();
});

test('it reads --clean', () => {
  expect(parseArgs(['--clean']).clean).toBeTrue();
});

test('it reads --keep', () => {
  expect(parseArgs(['--keep']).keep).toBeTrue();
});

test('it reads --reuse', () => {
  expect(parseArgs(['--reuse']).reuse).toBeTrue();
});

test('it leaves --clean, --keep and --reuse off unless given', () => {
  expect(parseArgs([])).toMatchObject({ clean: false, keep: false, reuse: false, help: false });
});

test.each([['-h'], ['--help']])('it reads %s as a request for help', (flag) => {
  expect(parseArgs([flag]).help).toBeTrue();
});

test('it rejects a suite or set it does not know', () => {
  expect(() => parseArgs(['--only', 'nope'])).toThrowWithMessage(
    Error,
    'unknown suite or set: nope',
  );
});

test('it rejects --only with no suite list after it', () => {
  expect(() => parseArgs(['--only'])).toThrowWithMessage(Error, '--only needs a suite list');
});

test('it rejects an --only list that names no suite', () => {
  expect(() => parseArgs(['--only', ','])).toThrowWithMessage(Error, '--only names no suite');
});

test('it rejects an argument it does not know', () => {
  expect(() => parseArgs(['--fast'])).toThrowWithMessage(Error, 'unknown argument: --fast');
});

test('it rejects --clean with --reuse', () => {
  expect(() => parseArgs(['--clean', '--reuse'])).toThrowWithMessage(
    Error,
    '--clean and --reuse contradict each other',
  );
});

test('it rejects --group with no number after it', () => {
  expect(() => parseArgs(['--group'])).toThrowWithMessage(Error, '--group needs a group number');
});

test.each([['0'], ['4'], ['one'], ['1.5'], ['01']])(
  'it rejects --group %s, which names no fast group',
  (group) => {
    expect(() => parseArgs(['--group', group])).toThrowWithMessage(
      Error,
      `--group takes 1 to 3, not ${group}`,
    );
  },
);

test('it rejects --group with --only', () => {
  expect(() => parseArgs(['--group', '1', '--only', 'sleep'])).toThrowWithMessage(
    Error,
    '--group and --only contradict each other',
  );
});
