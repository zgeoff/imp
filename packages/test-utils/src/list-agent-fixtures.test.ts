import { expect, test } from 'bun:test';
import { listAgentFixtures } from './list-agent-fixtures';

test('it lists the fixtures of a directory by name, sorted, without .json or its subdirectories', () => {
  expect(listAgentFixtures('host')).toStrictEqual([
    'cmdline',
    'image',
    'resize',
    'services-d',
    'signal',
    'tar',
  ]);
});
