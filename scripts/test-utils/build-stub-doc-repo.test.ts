import { expect, test } from 'bun:test';
import { buildStubDocRepo } from './build-stub-doc-repo';

test('it reads the text of a page', () => {
  const repo = buildStubDocRepo({ pages: { 'docs/guides/a.md': '# A' } });

  expect(repo.readPage('docs/guides/a.md')).toBe('# A');
});

test('it reports a page and a listed path as existing', () => {
  const repo = buildStubDocRepo({ pages: { 'docs/guides/a.md': '# A' }, paths: ['LICENSE'] });

  expect(['docs/guides/a.md', 'LICENSE'].map((path) => repo.exists(path))).toStrictEqual([
    true,
    true,
  ]);
});

test('it reports a path it was not given as missing, with no text', () => {
  const repo = buildStubDocRepo({ pages: { 'docs/guides/a.md': '# A' }, paths: ['LICENSE'] });

  expect([repo.exists('docs/guides/b.md'), repo.readPage('docs/guides/b.md')]).toStrictEqual([
    false,
    null,
  ]);
});

test('it gives no text for a listed path that is no page', () => {
  const repo = buildStubDocRepo({ pages: {}, paths: ['docs/guides'] });

  expect(repo.readPage('docs/guides')).toBeNull();
});
