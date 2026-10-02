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
import { countTarBytes } from '../cp/pack-local-path';
import { listContextEntries } from './pack-build-context';
import { createContextStream } from './run-image-build';

// `docker build -o` exports the image's files; FROM scratch pulls nothing
const HAS_BUILDX = Bun.spawnSync(['docker', 'buildx', 'version'], { stderr: 'ignore' }).success;

// past ustar's 100-byte name field, so the tar gives it a pax header
const LONG_NAME = `${'long-name-'.repeat(12)}.txt`;

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
  [LONG_NAME]: 'odd length',
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

// what `COPY . /` sees when buildx builds from the directory and from our tar
async function listDockerViews(
  files: Readonly<Record<string, string>>,
  dockerfile: string,
): Promise<{ readonly fromDir: string[]; readonly fromTar: string[] }> {
  const work = mkdtempSync(join(tmpdir(), 'imp-context-docker-'));

  try {
    const root = join(work, 'context');

    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }

    chmodSync(join(root, 'app.js'), 0o755);
    symlinkSync('app.js', join(root, 'start'));

    const entries = await listContextEntries(root, dockerfile);

    const tarPath = join(work, 'context.tar');

    await Bun.write(tarPath, new Response(createContextStream(entries, SILENT, () => {})));

    // the Content-Length the CLI sends
    const counted = await countTarBytes(entries);

    expect(counted).toBe(Bun.file(tarPath).size);

    const fromDir = join(work, 'from-dir');
    const fromTar = join(work, 'from-tar');

    runDocker([
      'buildx',
      'build',
      '--quiet',
      '-f',
      join(root, dockerfile),
      '-o',
      `type=local,dest=${fromDir}`,
      root,
    ]);

    runDocker(
      ['buildx', 'build', '--quiet', '-f', dockerfile, '-o', `type=local,dest=${fromTar}`, '-'],
      tarPath,
    );

    return { fromDir: listTree(fromDir), fromTar: listTree(fromTar) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test.skipIf(!HAS_BUILDX)(
  'docker sees the same files from the packed tar as from the directory',
  async () => {
    const views = await listDockerViews(FILES, 'Dockerfile');

    expect(views.fromTar).toEqual(views.fromDir);

    expect(views.fromTar).toEqual([
      '.dockerignore',
      'Dockerfile',
      'app.js*',
      'build/',
      'build/keep/',
      'build/keep/k.txt',
      'keep.log',
      LONG_NAME,
      'start@',
      'sub/',
      'sub/b.log',
      'sub/rooted.txt',
    ]);
  },
  120_000,
);

test.skipIf(!HAS_BUILDX)(
  'with <Dockerfile>.dockerignore, docker sees the same files from the tar',
  async () => {
    const views = await listDockerViews(
      {
        'web.Dockerfile': 'FROM scratch\nCOPY . /\n',
        'web.Dockerfile.dockerignore': '*.log\n.dockerignore\nweb.Dockerfile.dockerignore\n',
        '.dockerignore': 'app.js\n',
        'app.js': 'app',
        'a.log': '',
      },
      'web.Dockerfile',
    );

    expect(views.fromTar).toEqual(views.fromDir);
    expect(views.fromTar).toEqual(['app.js*', 'start@', 'web.Dockerfile']);
  },
  120_000,
);
