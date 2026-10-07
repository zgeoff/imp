import { expect, test } from 'bun:test';
import { splitHostFlag } from './host-flag';
import { UsageError } from './usage-error';

test('it takes --host out when it comes before the command', () => {
  expect(splitHostFlag(['--host', 'work', 'ls'])).toStrictEqual({ host: 'work', args: ['ls'] });
});

test('it takes --host= out when it comes after the command', () => {
  expect(splitHostFlag(['ls', '--json', '--host=work'])).toStrictEqual({
    host: 'work',
    args: ['ls', '--json'],
  });
});

test('it leaves --host after -- to the command imp exec runs', () => {
  expect(splitHostFlag(['exec', 'box', '--', 'curl', '--host', 'x'])).toStrictEqual({
    host: null,
    args: ['exec', 'box', '--', 'curl', '--host', 'x'],
  });
});

test.each([[['ls', '--host']], [['--host', '--json', 'ls']], [['--host=']], [['--host', '--']]])(
  'it rejects %p, a --host with no name, as a usage error',
  (args) => {
    expect(() => splitHostFlag(args)).toThrowWithMessage(
      UsageError,
      '--host needs a saved host name (see imp host ls)',
    );
  },
);
