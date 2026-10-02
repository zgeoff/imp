import { expect, test } from 'bun:test';
import { splitHostFlag } from './host-flag';

test('it takes --host out before or after the command', () => {
  expect(splitHostFlag(['--host', 'work', 'ls'])).toEqual({ host: 'work', args: ['ls'] });

  expect(splitHostFlag(['ls', '--json', '--host=work'])).toEqual({
    host: 'work',
    args: ['ls', '--json'],
  });
});

test('it leaves --host after -- to the command imp exec runs', () => {
  expect(splitHostFlag(['exec', 'box', '--', 'curl', '--host', 'x'])).toEqual({
    host: null,
    args: ['exec', 'box', '--', 'curl', '--host', 'x'],
  });
});

test('a --host with no name is a usage error', () => {
  for (const args of [
    ['ls', '--host'],
    ['--host', '--json', 'ls'],
    ['--host='],
    ['--host', '--'],
  ]) {
    expect(() => splitHostFlag(args)).toThrow('--host needs a saved host name');
  }
});
