import type { Repo } from '../check-doc-refs';

interface StubDocRepo {
  // each Markdown page's path and text
  readonly pages: Readonly<Record<string, string>>;

  // the other paths that exist, such as a folder or a file that is no page
  readonly paths?: readonly string[];
}

// Stands in for the checked-out repository that check-doc-refs reads: a path
// exists when it is a page or listed in paths, and only a page has text.
export function buildStubDocRepo(stub: StubDocRepo): Repo {
  const pages = new Map(Object.entries(stub.pages));
  const paths = new Set(stub.paths);

  return {
    exists: (path) => pages.has(path) || paths.has(path),
    readPage: (path) => pages.get(path) ?? null,
  };
}
