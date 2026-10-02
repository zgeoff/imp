import { expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CopyProgress } from '../cp/copy-progress';
import { listContextEntries } from './pack-build-context';
import { createContextStream } from './run-image-build';

// `docker build -o` exports the image's files; FROM scratch pulls nothing
const HAS_BUILDX = Bun.spawnSync(['docker', 'buildx', 'version'], { stderr: 'ignore' }).success;

const FILES: Readonly<Record<string, string>> = {
  Dockerfile: 'FROM scratch\nCOPY . /\n',
  '.dockerignore': [
    '*.log',
    '!keep.log',
    'node_modules',
    'build/**',
    '!build/keep/**',
    '**/*.tmp',
    'secret/',
    '# a comment',
    '/rooted.txt',
    '',
  ].join('\n'),
  'app.js': 'app',
  'a.log': '',
  'keep.log': '',
  'sub/b.log': '',
  'sub/c.tmp': '',
  'node_modules/x/y.js': '',
  'build/out.o': '',
  'build/keep/k.txt': '',
  'secret/key': '',
  'rooted.txt': '',
  'sub/rooted.txt': '',
};

const SILENT: CopyProgress = { setTotal: () => {}, add: () => {}, finish: () => {} };

// every path under dir, with `@` after a symlink and `*` after an executable file
function listTree(dir: string, prefix = ''): string[] {
  const names: string[] = [];

  for (const child of readdirSync(dir).toSorted()) {
    const path = join(dir, child);
    const name = `${prefix}${child}`;
    const stats = lstatSync(path);

    if (stats.isSymbolicLink()) {
      names.push(`${name}@`);
    } else if (stats.isDirectory()) {
      names.push(`${name}/`, ...listTree(path, `${name}/`));
    } else {
      const marked = (stats.mode & 0o111) === 0 ? name : `${name}*`;

      names.push(marked);
    }
  }

  return names;
}

function runDocker(argv: readonly string[], stdin?: string): void {
  const result = Bun.spawnSync(['docker', ...argv], {
    stdin: stdin === undefined ? 'ignore' : Bun.file(stdin),
    stderr: 'pipe',
  });

  if (!result.success) {
    throw new Error(`docker ${argv.join(' ')}: ${result.stderr.toString()}`);
  }
}

test.skipIf(!HAS_BUILDX)(
  'docker sees the same files from the packed tar as from the directory',
  async () => {
    const work = mkdtempSync(join(tmpdir(), 'imp-context-docker-'));

    try {
      const root = join(work, 'context');

      for (const [path, content] of Object.entries(FILES)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }

      chmodSync(join(root, 'app.js'), 0o755);
      symlinkSync('app.js', join(root, 'start'));

      const entries = await listContextEntries(root, 'Dockerfile');

      const tarPath = join(work, 'context.tar');

      await Bun.write(tarPath, new Response(createContextStream(entries, SILENT, () => {})));

      runDocker([
        'buildx',
        'build',
        '--quiet',
        '-o',
        `type=local,dest=${join(work, 'from-dir')}`,
        root,
      ]);

      runDocker(
        ['buildx', 'build', '--quiet', '-o', `type=local,dest=${join(work, 'from-tar')}`, '-'],
        tarPath,
      );

      const fromDir = listTree(join(work, 'from-dir'));
      const fromTar = listTree(join(work, 'from-tar'));

      expect(fromTar).toEqual(fromDir);

      expect(fromTar).toEqual([
        '.dockerignore',
        'Dockerfile',
        'app.js*',
        'build/',
        'build/keep/',
        'build/keep/k.txt',
        'keep.log',
        'start@',
        'sub/',
        'sub/b.log',
        'sub/rooted.txt',
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  120_000,
);
