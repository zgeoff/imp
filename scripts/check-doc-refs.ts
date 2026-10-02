// `bun run lint:docs`: fails on a docs reference whose page or heading is missing (code
// comments, Markdown links, blob URLs), on a heading named only in prose, and on any mention
// of a file #6 removed.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';

// the files the docs tree replaced; nothing may cite them again
const REMOVED = /\bDESIGN(?:\.md| \d)|agent\/PROTOCOL\.md|sleep-findings/u;

// `docs/guides/tokens.md#scopes`, or a bare `tokens.md#scopes` that names a docs page
const DOC_PATH = /(?<![\w/.-])docs\/[\w/-]+\.md(?:#[\w-]+)?/gu;
const BARE_PAGE = /(?<![\w/.-])[\w-]+\.md(?:#[\w-]+)?/gu;
const DOC_DIRS = ['docs/architecture', 'docs/guides'];

// this repo's files by URL: https://github.com/zgeoff/imp/blob/main/<path>
const BLOB_URL = /github\.com\/zgeoff\/imp\/blob\/main\/(?<path>[^\s)"'>]+)/gu;

// Markdown links and HTML hrefs, resolved against the page
const MD_LINK = /\]\((?<target>[^)\s]+)\)|href="(?<href>[^"]+)"/gu;

// headings named only in prose, which no check can follow
const PROSE_HEADINGS: readonly (readonly [RegExp, string])[] = [
  [/\.md,?\s+\(?["“]/u, 'names a heading in quotes'],
  [/\.md,?\s+(?:gotcha|finding|section)\s+\d/u, 'names a section in prose'],
  [/\.md,\s+[A-Z][\w ]*\)/u, 'names a heading after a comma'],
  [/\bdocs\/[\w-]+\/\s*$/u, 'splits a docs path across lines'],
];

// this checker and its test spell out the removed names on purpose
const SELF = new Set(['scripts/check-doc-refs.ts', 'scripts/check-doc-refs.test.ts']);

export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

// the repository as the check sees it: whether a path exists, and a Markdown page's text
export interface Repo {
  readonly exists: (path: string) => boolean;
  readonly readPage: (path: string) => string | null;
}

// GitHub's heading anchor: link and code syntax gone, lowercase, every character but a
// letter, digit, `_`, `-` or space dropped, and each space a `-` (runs are kept)
export function buildAnchor(heading: string): string {
  return heading
    .replaceAll(/\[(?<text>[^\]]*)\]\([^)]*\)/gu, '$<text>')
    .replaceAll('`', '')
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}_ -]/gu, '')
    .replaceAll(' ', '-');
}

// every anchor a Markdown page has; a repeated heading gets `-1`, `-2`…
export function readAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();

  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
    }

    const heading = inFence ? null : /^#{1,6}\s+(?<title>.*)/u.exec(line);
    const title = heading?.groups?.['title'];

    if (title !== undefined) {
      const slug = buildAnchor(title.replace(/\s+#+\s*$/u, ''));
      const count = seen.get(slug) ?? 0;
      const anchor = count === 0 ? slug : `${slug}-${String(count)}`;

      anchors.add(anchor);
      seen.set(slug, count + 1);
    }
  }

  return anchors;
}

interface Target {
  readonly path: string;
  readonly anchor: string | undefined;
}

function splitTarget(ref: string): Target {
  const [path = '', anchor] = ref.split('#');

  return { path, anchor };
}

// what a line of code points at in the docs tree
function findCodeTargets(line: string, repo: Repo): Target[] {
  const targets = [...line.matchAll(DOC_PATH)].map(([ref]) => splitTarget(ref));

  for (const [ref] of line.matchAll(BARE_PAGE)) {
    const target = splitTarget(ref);
    const page = DOC_DIRS.map((dir) => `${dir}/${target.path}`).find((full) => repo.exists(full));

    // a bare name that is no docs page (README.md, CHANGELOG.md) is not a docs reference
    if (page !== undefined) {
      targets.push({ path: page, anchor: target.anchor });
    }
  }

  return targets;
}

// what a line of Markdown links to, resolved against the page
function findMarkdownTargets(file: string, line: string): Target[] {
  const targets: Target[] = [];

  for (const match of line.matchAll(MD_LINK)) {
    const link = match.groups?.['target'] ?? match.groups?.['href'] ?? '';

    // another site, or this repo by URL (BLOB_URL covers it)
    if (/^[a-z][\w+.-]*:/u.test(link)) {
      continue;
    }

    const target = splitTarget(link);
    const relative = posix.join(posix.dirname(file), target.path);
    const resolved = target.path === '' ? file : posix.normalize(relative);

    targets.push({ path: resolved, anchor: target.anchor });
  }

  return targets;
}

function checkTarget(target: Target, repo: Repo): string | null {
  const path = target.path.replace(/\/$/u, '');

  if (!repo.exists(path)) {
    return `${path} does not exist`;
  }

  const page = path.endsWith('.md') ? repo.readPage(path) : null;

  if (target.anchor !== undefined && page !== null && !readAnchors(page).has(target.anchor)) {
    return `${path} has no heading #${target.anchor}`;
  }

  return null;
}

export function checkFile(file: string, text: string, repo: Repo): Problem[] {
  const problems: Problem[] = [];
  const isMarkdown = file.endsWith('.md');

  for (const [index, line] of text.split('\n').entries()) {
    const at = { file, line: index + 1 };

    if (REMOVED.test(line)) {
      problems.push({ ...at, message: 'cites a removed doc; point it at docs/' });
    }

    const blobTargets = [...line.matchAll(BLOB_URL)].map((match) =>
      splitTarget(match.groups?.['path'] ?? ''),
    );

    const lineTargets = isMarkdown ? findMarkdownTargets(file, line) : findCodeTargets(line, repo);

    for (const [pattern, message] of isMarkdown ? [] : PROSE_HEADINGS) {
      if (pattern.test(line)) {
        problems.push({ ...at, message: `${message}; use docs/<page>.md#<anchor>` });
      }
    }

    for (const target of [...blobTargets, ...lineTargets]) {
      const message = checkTarget(target, repo);

      if (message !== null) {
        problems.push({ ...at, message });
      }
    }
  }

  return problems;
}

function listTrackedFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z'], { stdout: 'pipe' });

  if (result.exitCode !== 0) {
    throw new Error('git ls-files failed');
  }

  return result.stdout.toString().split('\0').filter(Boolean);
}

function readText(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }

  const bytes = readFileSync(path);

  // a NUL byte means binary: nothing to cite
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

function main(): void {
  const pages = new Map<string, string | null>();

  const repo: Repo = {
    exists: (path) => existsSync(path),
    readPage: (path) => {
      if (!pages.has(path)) {
        pages.set(path, readText(path));
      }

      return pages.get(path) ?? null;
    },
  };

  const files = listTrackedFiles().filter((file) => !SELF.has(file));

  const problems = files.flatMap((file) => {
    const text = readText(file);

    return text === null ? [] : checkFile(file, text, repo);
  });

  for (const problem of problems) {
    console.error(`${problem.file}:${String(problem.line)}: ${problem.message}`);
  }

  if (problems.length > 0) {
    process.exit(1);
  }

  console.log(`check-doc-refs: ${String(files.length)} files, every docs reference resolves`);
}

if (import.meta.main) {
  main();
}
