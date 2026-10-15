// Checks every docs/ path that code cites, with its #anchor, and exits non-zero on one that does
// not resolve. `bun run lint:docs` runs it after the docs-writing skill's check-links.sh, which
// covers the links in Markdown. Usage (from the repo root): bun scripts/ci/check-doc-citations.ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

// `docs/guides/tokens.md#scopes` or `docs/reference`, not a docs/ folder of another path
const DOC_PATH = /(?<![\w/.-])docs(?:\/[\w.-]+)+(?:#[\w-]+)?/gu;

// this repo's docs by URL, on any ref: https://github.com/zgeoff/impz/blob/main/docs/…
const BLOB_URL =
  /github\.com\/zgeoff\/impz\/(?:blob|tree)\/[^/\s]+\/(?<ref>docs(?:\/[\w.-]+)+(?:#[\w-]+)?)/gu;

// `files` are paths relative to `root`, the repository root that every citation starts from
export function checkDocCitations(root: string, files: readonly string[]): Problem[] {
  const pages = new Map<string, Set<string> | null>();

  const repo: Repo = {
    exists: (path) => existsSync(join(root, path)),
    readAnchors: (path) => {
      if (!pages.has(path)) {
        const page = readText(join(root, path));
        const anchors = page === null ? null : collectAnchors(page);

        pages.set(path, anchors);
      }

      return pages.get(path) ?? null;
    },
  };

  return files.flatMap((file) => {
    const text = readText(join(root, file));

    return text === null ? [] : checkFile(file, text, repo);
  });
}

// the repository as one run sees it, with each page's anchors read once
interface Repo {
  readonly exists: (path: string) => boolean;
  readonly readAnchors: (path: string) => Set<string> | null;
}

function checkFile(file: string, text: string, repo: Repo): Problem[] {
  const problems: Problem[] = [];

  for (const [index, line] of text.split('\n').entries()) {
    const refs = [
      ...[...line.matchAll(DOC_PATH)].map((match) => match[0]),
      ...[...line.matchAll(BLOB_URL)].map((match) => match.groups?.['ref'] ?? ''),
    ];

    for (const ref of refs) {
      const message = checkCitation(ref, repo);

      if (message !== null) {
        problems.push({ file, line: index + 1, message });
      }
    }
  }

  return problems;
}

// a sentence's full stop is no part of the path
function checkCitation(ref: string, repo: Repo): string | null {
  const [rawPath = '', anchor] = ref.split('#');
  const path = rawPath.replace(/\.+$/u, '');

  if (!repo.exists(path)) {
    return `${path} does not exist`;
  }

  const anchors = anchor !== undefined && path.endsWith('.md') ? repo.readAnchors(path) : null;

  if (anchors !== null && anchor !== undefined && !anchors.has(anchor)) {
    return `${path} has no heading #${anchor}`;
  }

  return null;
}

// GitHub's anchors of a page: ATX and setext headings outside code fences and front matter,
// numbered on repeat, plus explicit id and name attributes
function collectAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();

  const lines = markdown.split('\n');
  const start = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : 0;
  let fence = '';
  let previous = '';

  for (const line of lines.slice(start)) {
    const marker = /^\s*(?<marker>`{3,}|~{3,})(?<rest>.*)$/u.exec(line)?.groups;

    if (marker !== undefined) {
      fence = updateFence(fence, marker['marker'] ?? '', marker['rest'] ?? '');
      previous = '';
      continue;
    }

    if (fence !== '') {
      continue;
    }

    const title = findHeading(line, previous);

    if (title !== null) {
      const slug = buildSlug(title);
      const count = seen.get(slug) ?? 0;
      const anchor = count === 0 ? slug : `${slug}-${String(count)}`;

      anchors.add(anchor);
      seen.set(slug, count + 1);
    }

    for (const match of line.matchAll(/\b(?:id|name)\s*=\s*"(?<id>[^"]+)"/gu)) {
      anchors.add(match.groups?.['id'] ?? '');
    }

    previous = line;
  }

  return anchors;
}

// a fence closes on a marker of its own character, at least as long, with nothing after it
function updateFence(open: string, marker: string, rest: string): string {
  if (open === '') {
    return marker;
  }

  const isClose = marker[0] === open[0] && marker.length >= open.length && rest.trim() === '';

  return isClose ? '' : open;
}

function findHeading(line: string, previous: string): string | null {
  const atx = /^ {0,3}#{1,6}(?:\s+(?<title>.*?))?\s*$/u.exec(line);

  if (atx !== null) {
    return (atx.groups?.['title'] ?? '').replace(/\s+#+\s*$/u, '');
  }

  const isUnderline = /^ {0,3}(?:=+|-+)\s*$/u.test(line);
  const isParagraph = /\S/u.test(previous) && !/^\s*(?:[-*+]\s|\d+[.)]\s|>|#|\|)/u.test(previous);

  return isUnderline && isParagraph ? previous.trim() : null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
};

// GitHub slugs the rendered heading: outside code spans, link syntax, HTML tags and emphasis
// markers drop and entities decode; then lowercase, every character but a letter, mark, digit,
// `_`, `-` or space dropped, and each space a `-`
function buildSlug(title: string): string {
  const rendered = title
    .split(/(?<span>`+[^`]*`+)/u)
    .map((part) => {
      const code = /^`+(?<code>[^`]*)`+$/u.exec(part);

      if (code !== null) {
        return code.groups?.['code'] ?? '';
      }

      return part
        .replaceAll(/!?\[(?<text>[^\]]*)\]\([^)]*\)/gu, '$<text>')
        .replaceAll(/<[^>]+>/gu, '')
        .replaceAll(/(?<![\p{L}\p{N}])[_*]+|[_*]+(?![\p{L}\p{N}])/gu, '')
        .replaceAll(/&#(?<code>\d+);/gu, (_, digits: string) =>
          String.fromCodePoint(Number(digits)),
        )
        .replaceAll(/&#x(?<code>[\da-f]+);/giu, (_, hex: string) =>
          String.fromCodePoint(Number.parseInt(hex, 16)),
        )
        .replaceAll(/&(?<name>amp|lt|gt|quot|nbsp);/gu, (_, name: string) => ENTITIES[name] ?? '');
    })
    .join('');

  return rendered
    .toLowerCase()
    .trim()
    .replaceAll(/[^\p{L}\p{M}\p{N}_\- ]/gu, '')
    .replaceAll(' ', '-');
}

// Markdown is check-links.sh's; the synced skills cite placeholder pages as examples, and this
// check's own test cites missing ones on purpose
const SKIPPED = [/\.md$/u, /^\.claude\//u, /^scripts\/ci\/check-doc-citations\.test\.ts$/u];

function main(): void {
  const files = listFiles().filter((file) => !SKIPPED.some((pattern) => pattern.test(file)));
  const problems = checkDocCitations(process.cwd(), files);

  for (const problem of problems) {
    console.error(`${problem.file}:${String(problem.line)}: ${problem.message}`);
  }

  if (problems.length > 0) {
    process.exit(1);
  }

  console.log(`check-doc-citations: ${String(files.length)} files, every docs/ citation resolves`);
}

// untracked files too, so a new file is checked before it is staged
function listFiles(): string[] {
  const result = Bun.spawnSync(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { stdout: 'pipe' },
  );

  if (result.exitCode !== 0) {
    throw new Error('git ls-files failed');
  }

  return [...new Set(result.stdout.toString().split('\0').filter(Boolean))];
}

// null for a file that is gone from the tree or binary (a NUL byte): nothing to cite
function readText(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return null;
  }

  const bytes = readFileSync(path);

  return bytes.includes(0) ? null : bytes.toString('utf8');
}

if (import.meta.main) {
  main();
}
