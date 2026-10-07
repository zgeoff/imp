import { expect, test } from 'bun:test';
import { buildStubDocRepo } from './build-stub-doc-repo';

test('it reads the text of a page', () => {
  const repo = buildStubDocRepo({ pages: { 'pages/a.md': '# A' } });

  expect(repo.readPage('pages/a.md')).toBe('# A');
});

test('it reports a page and a listed path as existing', () => {
  const repo = buildStubDocRepo({ pages: { 'pages/a.md': '# A' }, paths: ['LICENSE'] });

  expect(['pages/a.md', 'LICENSE'].map((path) => repo.exists(path))).toStrictEqual([true, true]);
});

test('it reports a path it was not given as missing, with no text', () => {
  const repo = buildStubDocRepo({ pages: { 'pages/a.md': '# A' }, paths: ['LICENSE'] });

  expect([repo.exists('pages/b.md'), repo.readPage('pages/b.md')]).toStrictEqual([false, null]);
});

test('it gives no text for a listed path that is no page', () => {
  const repo = buildStubDocRepo({ pages: {}, paths: ['pages'] });

  expect(repo.readPage('pages')).toBeNull();
});
