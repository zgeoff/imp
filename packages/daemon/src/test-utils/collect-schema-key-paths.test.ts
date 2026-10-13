import { expect, test } from 'bun:test';
import * as z from 'zod';
import { collectSchemaKeyPaths } from './collect-schema-key-paths';

test('it lists the keys of an object, optional and nested ones included', () => {
  const resumeFrom = z.object({ offset: z.int() });
  const schema = z.object({ op: z.literal('exec'), resume_from: resumeFrom.optional() });

  expect(collectSchemaKeyPaths(schema)).toStrictEqual(['op', 'resume_from', 'resume_from.offset']);
});

test('it lists the keys of an array of objects under the items path', () => {
  const item = z.object({ name: z.string() });
  const schema = z.object({ argv: z.array(item).readonly() });

  expect(collectSchemaKeyPaths(schema)).toStrictEqual(['argv', 'argv[]', 'argv[].name']);
});

test('it lists the keys of every option of a union', () => {
  const exact = z.object({ kind: z.literal('exact') });
  const gap = z.object({ kind: z.literal('gap'), from: z.int() });

  expect(collectSchemaKeyPaths(z.discriminatedUnion('kind', [exact, gap]))).toStrictEqual([
    'from',
    'kind',
  ]);
});

test('it stops at the items of an array whose items are unknown, transformed or not', () => {
  const sessions = z.array(z.unknown()).default([]);
  const schema = z.object({ sessions: sessions.transform((list) => list.length) });

  expect(collectSchemaKeyPaths(schema)).toStrictEqual(['sessions', 'sessions[]']);
});
