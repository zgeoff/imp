import { expect, test } from 'bun:test';
import { collectJsonKeyPaths } from './collect-json-key-paths';

test('it lists the nested keys of an object, sorted', () => {
  expect(collectJsonKeyPaths({ op: 'exec', resume_from: { offset: 1 } })).toStrictEqual([
    'op',
    'resume_from',
    'resume_from.offset',
  ]);
});

test('it lists the keys of every item of an array under one path', () => {
  expect(collectJsonKeyPaths({ sessions: [{ name: 'a' }, { pid: 1 }] })).toStrictEqual([
    'sessions',
    'sessions[]',
    'sessions[].name',
    'sessions[].pid',
  ]);
});

test('it lists an empty array as the array and its items', () => {
  expect(collectJsonKeyPaths({ argv: [] })).toStrictEqual(['argv', 'argv[]']);
});

test('it lists nothing for a scalar', () => {
  expect(collectJsonKeyPaths('ping')).toStrictEqual([]);
});
