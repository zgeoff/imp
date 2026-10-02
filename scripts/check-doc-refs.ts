// `bun run lint:docs`: fails on a `docs/<page>.md#<anchor>` in code whose page
// or heading is missing, on a heading named in quotes, and anywhere on a
// mention of a file #6 removed.
import { existsSync, readFileSync } from 'node:fs';

// the files the docs tree replaced; nothing may cite them again
const REMOVED = /\bDESIGN(?:\.md| \d)|agent\/PROTOCOL\.md|sleep-findings/u;

// `docs/guides/tokens.md` or `docs/guides/tokens.md#scopes`
const DOC_REF = /\bdocs\/[\w/-]+\.md(?:#[\w-]+)?/gu;

// a heading named in quotes after the page, which no check can follow:
// `docs/x.md ("Boot")` or `docs/x.md, "CI"`
const QUOTED_HEADING = /\bdocs\/[\w/-]+\.md,?\s+\(?"/u;

// this checker and its test spell out the removed names on purpose
const SELF = new Set(['scripts/check-doc-refs.ts', 'scripts/check-doc-refs.test.ts']);

export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

// GitHub's heading anchor: lowercase, punctuation other than `-` dropped,
// spaces to `-`
export function buildAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\s_-]/gu, '')
    .replaceAll(/\s/gu, '-');
}

// every anchor a Markdown page has; a repeated heading gets `-1`, `-2`…
export function readAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();

  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
    }

    const heading = inFence ? null : /^#{1,6}\s+(?<title>.*)/u.exec(line);

    if (heading?.groups?.['title'] !== undefined) {
      const slug = buildAnchor(heading.groups['title']);
      const count = seen.get(slug) ?? 0;
      const anchor = count === 0 ? slug : `${slug}-${String(count)}`;

      anchors.add(anchor);
      seen.set(slug, count + 1);
    }
  }

  return anchors;
}

// `readPage` gives a page's Markdown, or null when it does not exist
export function checkFile(
  file: string,
  text: string,
  readPage: (path: string) => string | null,
): Problem[] {
  const problems: Problem[] = [];
  const isMarkdown = file.endsWith('.md');

  for (const [index, line] of text.split('\n').entries()) {
    const at = { file, line: index + 1 };

    if (REMOVED.test(line)) {
      problems.push({ ...at, message: 'cites a removed doc; point it at docs/' });
    }

    // Markdown links are relative to the page and carry their own checks
    if (isMarkdown) {
      continue;
    }

    if (QUOTED_HEADING.test(line)) {
      problems.push({ ...at, message: 'names a heading in quotes; use docs/<page>.md#<anchor>' });
    }

    for (const [ref] of line.matchAll(DOC_REF)) {
      const [path = '', anchor] = ref.split('#');
      const page = readPage(path);

      if (page === null) {
        problems.push({ ...at, message: `${path} does not exist` });
      } else if (anchor !== undefined && !readAnchors(page).has(anchor)) {
        problems.push({ ...at, message: `${path} has no heading #${anchor}` });
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
  if (!existsSync(path)) {
    return null;
  }

  const bytes = readFileSync(path);

  // a NUL byte means binary: nothing to cite
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

function main(): void {
  const pages = new Map<string, string | null>();

  const readPage = (path: string): string | null => {
    if (!pages.has(path)) {
      pages.set(path, readText(path));
    }

    return pages.get(path) ?? null;
  };

  const files = listTrackedFiles().filter((file) => !SELF.has(file));

  const problems = files.flatMap((file) => {
    const text = readText(file);

    return text === null ? [] : checkFile(file, text, readPage);
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
