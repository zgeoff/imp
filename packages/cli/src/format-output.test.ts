import { expect, test } from 'bun:test';
import { formatCheckpoints, formatTable } from './format-output';

test('it pads each column to its widest cell', () => {
  const table = formatTable(
    ['NAME', 'STATE'],
    [
      ['dev', 'running'],
      ['scratchpad', 'sleeping'],
    ],
  );

  expect(table).toBe(
    ['NAME        STATE', 'dev         running', 'scratchpad  sleeping'].join('\n'),
  );
});

test('it lists checkpoints with their size in MiB', () => {
  const table = formatCheckpoints([
    { id: 'cp-a2b3c4', label: 'clean', createdAt: new Date(0), sizeBytes: 3_145_728 },
    { id: 'cp-d5e6f7', createdAt: new Date(0) },
  ]);

  expect(table.split('\n')).toEqual([
    'ID         LABEL  CREATED                   SIZE',
    'cp-a2b3c4  clean  1970-01-01T00:00:00.000Z  3 MiB',
    'cp-d5e6f7         1970-01-01T00:00:00.000Z',
  ]);
});
