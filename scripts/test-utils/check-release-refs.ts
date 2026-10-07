// the image, and a file of a release tag, such as docs/guides/install.md's bootstrap.sh URL
const RELEASE_REF =
  /ghcr\.io\/zgeoff\/imp-host:(?<tag>[\w.\-]+)|zgeoff\/imp\/v(?<source>[\w.\-]+)\//gv;

// a deploy file from main names main's code, not a release's
const MAIN_URL = 'raw.githubusercontent.com/zgeoff/imp/main/deploy/';

// release-please's VERSION_REGEX, less its pre-release and build parts
const VERSION = /\d+\.\d+\.\d+/v;
const INLINE = 'x-release-please-version';
const BLOCK_START = 'x-release-please-start-version';
const BLOCK_END = 'x-release-please-end';

// the old template's line, which bootstrap.sh and upgrade.sh turn into a comment
const LEGACY_DEFINITION = /^readonly (?:LEGACY_IMAGE_LINE|legacy_image_line)=/v;

// a guide's prose may name another tag, such as latest; its code may not
const FENCE = /^\s*```/v;

export interface ReleaseRefs {
  // each reference that release-please would leave wrong, as `<file>:<line>: <why>`
  readonly problems: readonly string[];

  // the references to version under a marker, which release-please moves to the next release
  readonly defaults: number;
}

// Checks a file whose marked lines release-please's generic updater rewrites: every release
// reference must be version and marked, and the first X.Y.Z of a marked line must be one. A
// Markdown file's prose may name another tag; its code may not.
export function checkReleaseRefs(file: string, text: string, version: string): ReleaseRefs {
  const problems: string[] = [];
  let defaults = 0;
  let inBlock = false;
  let inFence = false;

  for (const [index, line] of text.split('\n').entries()) {
    const where = `${file}:${String(index + 1)}`;
    const fence = FENCE.test(line);

    inFence = fence ? !inFence : inFence;

    let marked = line.includes(INLINE);

    if (!marked && inBlock) {
      marked = true;
      inBlock = !line.includes(BLOCK_END);
    } else if (!marked && line.includes(BLOCK_START)) {
      inBlock = true;
    }

    const prose = file.endsWith('.md') && !fence && !inFence;
    const refs = [...line.matchAll(RELEASE_REF)];

    for (const match of refs) {
      const tag = match.groups?.['tag'] ?? match.groups?.['source'] ?? '';

      if (tag === version && marked) {
        defaults += 1;
      } else if (tag === version) {
        problems.push(`${where}: ${match[0]} is under no marker`);
      } else if (!prose && !(tag === 'latest' && LEGACY_DEFINITION.test(line))) {
        problems.push(`${where}: ${match[0]} is not this release (${version})`);
      }
    }

    if (line.includes(MAIN_URL)) {
      problems.push(`${where}: fetches from main, not this release`);
    }

    const first = marked ? VERSION.exec(line) : null;

    const inRef = refs.some(
      (match) =>
        first !== null && first.index >= match.index && first.index < match.index + match[0].length,
    );

    if (first !== null && !inRef) {
      problems.push(`${where}: the first X.Y.Z, ${first[0]}, is not a release reference`);
    }
  }

  return { problems, defaults };
}
