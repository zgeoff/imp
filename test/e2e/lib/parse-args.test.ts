import { expect, test } from 'bun:test';
import { parseArgs } from './parse-args';

test('it runs the acceptance set when no suite is named', () => {
  const args = parseArgs([]);

  expect(args.acceptance).toBeTrue();

  expect(args.suites).toEqual([
    'lifecycle',
    'docker',
    'images',
    'checkpoints',
    'disks',
    'sleep',
    'scale',
    'restart',
    'tailscale',
    'mcp',
    'sessions',
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
    'egress',
    'cpu',
    'backups',
  ]);
});

test('it runs named suites in run order, not the order given', () => {
  const args = parseArgs(['--only', 'restart,checkpoints']);

  expect(args.suites).toEqual(['checkpoints', 'restart']);
  expect(args.acceptance).toBeFalse();
});

test('it expands a set and drops duplicates', () => {
  expect(parseArgs(['--only', 'fast,sleep']).suites).toEqual([
    'lifecycle',
    'checkpoints',
    'disks',
    'sleep',
    'restart',
    'mcp',
    'services',
    'ssh',
    'ssh-agent',
    'reverse',
    'proxy',
    'dashboard',
    'tokens',
    'cpu',
  ]);
});

test('it treats an explicit acceptance set as the definition of done', () => {
  expect(parseArgs(['--only', 'acceptance']).acceptance).toBeTrue();
});

test('it reads the flags', () => {
  expect(parseArgs(['--clean', '--keep'])).toMatchObject({ clean: true, keep: true, reuse: false });
  expect(parseArgs(['--reuse']).reuse).toBeTrue();
  expect(parseArgs(['-h']).help).toBeTrue();
});

test('it rejects what it does not know', () => {
  expect(() => parseArgs(['--only', 'nope'])).toThrowWithMessage(
    Error,
    'unknown suite or set: nope',
  );

  expect(() => parseArgs(['--only'])).toThrowWithMessage(Error, '--only needs a suite list');
  expect(() => parseArgs(['--only', ','])).toThrowWithMessage(Error, '--only names no suite');
  expect(() => parseArgs(['--fast'])).toThrowWithMessage(Error, 'unknown argument: --fast');

  expect(() => parseArgs(['--clean', '--reuse'])).toThrowWithMessage(
    Error,
    '--clean and --reuse contradict each other',
  );
});
