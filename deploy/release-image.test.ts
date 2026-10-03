import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as z from 'zod';

// The non-Nix deploy files and guides name their own release's image. release-please's generic
// updater rewrites the first X.Y.Z of each marked line, so every default must sit under a
// marker, in a file the config lists, and name package.json's version.
const root = path.join(import.meta.dir, '..');

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
const ExtraFileSchema = z.object({ type: z.string(), path: z.string() });
const PackageSchema = z.object({ 'extra-files': z.array(ExtraFileSchema) });
const ConfigSchema = z.object({ packages: z.object({ '.': PackageSchema }) });

function readRepoFile(name: string): string {
  return readFileSync(path.join(root, name), 'utf8');
}

const version = z
  .object({ version: z.string() })
  .parse(JSON.parse(readRepoFile('package.json'))).version;

const genericFiles = ConfigSchema.parse(JSON.parse(readRepoFile('release-please-config.json')))
  .packages['.']['extra-files'].filter((file) => file.type === 'generic')
  .map((file) => file.path);

interface MarkedLine {
  readonly number: number;
  readonly text: string;
  readonly marked: boolean;
  readonly prose: boolean;
}

// each line, whether release-please rewrites its first X.Y.Z, and whether it is a guide's prose
function readLines(file: string, text: string): MarkedLine[] {
  let inBlock = false;
  let inFence = false;

  return text.split('\n').map((line, index) => {
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

    return { number: index + 1, text: line, marked, prose };
  });
}

test('the root package.json holds a release version', () => {
  expect(version).toMatch(/^\d+\.\d+\.\d+$/v);
});

test('every file with a marker is a generic extra-file of the release-please config', () => {
  const result = Bun.spawnSync(['git', 'grep', '-l', 'x-release-please-', '--', ':!*.test.ts'], {
    cwd: root,
  });

  const marked = result.stdout.toString().trim().split('\n');

  expect(marked.toSorted()).toEqual(genericFiles.toSorted());
});

for (const file of genericFiles) {
  test(`${file} names release ${version} at every marked default, and no other`, () => {
    const lines = readLines(file, readRepoFile(file));
    const problems: string[] = [];
    let defaults = 0;

    for (const line of lines) {
      const where = `${file}:${line.number}`;
      const refs = [...line.text.matchAll(RELEASE_REF)];

      for (const match of refs) {
        const tag = match.groups?.['tag'] ?? match.groups?.['source'] ?? '';

        if (tag === version && line.marked) {
          defaults += 1;
        } else if (tag === version) {
          problems.push(`${where}: ${match[0]} is under no marker`);
        } else if (!line.prose && !(tag === 'latest' && LEGACY_DEFINITION.test(line.text))) {
          problems.push(`${where}: ${match[0]} is not this release (${version})`);
        }
      }

      if (line.text.includes(MAIN_URL)) {
        problems.push(`${where}: fetches from main, not this release`);
      }

      // release-please rewrites the first X.Y.Z of a marked line, wherever it is
      const first = line.marked ? VERSION.exec(line.text) : null;

      const inRef = refs.some(
        (match) =>
          first !== null &&
          first.index >= match.index &&
          first.index < match.index + match[0].length,
      );

      if (first !== null && !inRef) {
        problems.push(`${where}: the first X.Y.Z, ${first[0]}, is not a release reference`);
      }
    }

    expect(problems).toEqual([]);
    expect(defaults).toBeGreaterThan(0);
  });
}
