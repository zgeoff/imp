import { expect, mock, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { countTarBytes, listContextEntries } from '@imp/local-tar';
import { listTree } from '../test-utils/list-tree';
import { checkDockerBuildx, runDockerBuild } from '../test-utils/run-docker-build';
import { createContextStream } from './run-image-build';

// `COPY . /` as docker buildx sees it, from the directory and from the tar
// the CLI packs; each test skips where buildx is missing

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const work = await mkdtemp(join(tmpdir(), 'imp-context-docker-'));

  stack.defer(() => rm(work, { recursive: true, force: true }));

  const owned = stack.move();

  return {
    context: join(work, 'context'),
    tarPath: join(work, 'context.tar'),
    fromDir: join(work, 'from-dir'),
    fromTar: join(work, 'from-tar'),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

test.skipIf(!checkDockerBuildx())(
  'it packs the files docker sees from the directory, honouring .dockerignore',
  async () => {
    await using ctx = await setupTest();

    // past ustar's 100-byte name field, so the tar gives it a pax header
    const longName = `${'long-name-'.repeat(12)}.txt`;

    await Promise.all(
      Object.entries({
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
        [longName]: 'odd length',
      }).map(async ([path, content]) => {
        await mkdir(dirname(join(ctx.context, path)), { recursive: true });
        await writeFile(join(ctx.context, path), content);
      }),
    );

    await chmod(join(ctx.context, 'app.js'), 0o755);
    await symlink('app.js', join(ctx.context, 'start'));

    const entries = await listContextEntries(ctx.context, 'Dockerfile');

    const progress = {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    };

    const packed = createContextStream(entries, progress, mock<(text: string) => void>());

    await Bun.write(ctx.tarPath, new Response(packed));

    runDockerBuild({
      dockerfile: join(ctx.context, 'Dockerfile'),
      context: { dir: ctx.context },
      dest: ctx.fromDir,
    });

    runDockerBuild({
      dockerfile: 'Dockerfile',
      context: { tarPath: ctx.tarPath },
      dest: ctx.fromTar,
    });

    // the Content-Length the CLI sends
    const counted = await countTarBytes(entries);
    const fromDir = await listTree(ctx.fromDir);
    const fromTar = await listTree(ctx.fromTar);

    expect(counted).toBe(Bun.file(ctx.tarPath).size);
    expect(fromTar).toStrictEqual(fromDir);

    expect(fromTar).toStrictEqual([
      '.dockerignore',
      'Dockerfile',
      'app.js*',
      'build/',
      'build/keep/',
      'build/keep/k.txt',
      'keep.log',
      longName,
      'start@',
      'sub/',
      'sub/b.log',
      'sub/rooted.txt',
    ]);
  },
  120_000,
);

test.skipIf(!checkDockerBuildx())(
  'it packs the files docker sees with a <Dockerfile>.dockerignore',
  async () => {
    await using ctx = await setupTest();

    await mkdir(ctx.context);

    await Promise.all(
      Object.entries({
        'web.Dockerfile': 'FROM scratch\nCOPY . /\n',
        'web.Dockerfile.dockerignore': '*.log\n.dockerignore\nweb.Dockerfile.dockerignore\n',
        '.dockerignore': 'app.js\n',
        'app.js': 'app',
        'a.log': '',
      }).map(([path, content]) => writeFile(join(ctx.context, path), content)),
    );

    await chmod(join(ctx.context, 'app.js'), 0o755);
    await symlink('app.js', join(ctx.context, 'start'));

    const entries = await listContextEntries(ctx.context, 'web.Dockerfile');

    const progress = {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    };

    const packed = createContextStream(entries, progress, mock<(text: string) => void>());

    await Bun.write(ctx.tarPath, new Response(packed));

    runDockerBuild({
      dockerfile: join(ctx.context, 'web.Dockerfile'),
      context: { dir: ctx.context },
      dest: ctx.fromDir,
    });

    runDockerBuild({
      dockerfile: 'web.Dockerfile',
      context: { tarPath: ctx.tarPath },
      dest: ctx.fromTar,
    });

    const counted = await countTarBytes(entries);
    const fromDir = await listTree(ctx.fromDir);
    const fromTar = await listTree(ctx.fromTar);

    expect(counted).toBe(Bun.file(ctx.tarPath).size);
    expect(fromTar).toStrictEqual(fromDir);
    expect(fromTar).toStrictEqual(['app.js*', 'start@', 'web.Dockerfile']);
  },
  120_000,
);

// the CLI falls back to dockerfile before it reads an ignore file, so
// dockerfile.dockerignore applies, not Dockerfile.dockerignore
test.skipIf(!checkDockerBuildx())(
  'it uses the ignore file of a lowercase dockerfile it falls back to',
  async () => {
    await using ctx = await setupTest();

    await mkdir(ctx.context);

    await Promise.all(
      Object.entries({
        dockerfile: 'FROM scratch\nCOPY . /\n',
        'Dockerfile.dockerignore': 'a.txt\n',
        'dockerfile.dockerignore': 'b.txt\n',
        '.dockerignore': 'c.txt\n',
        'app.js': 'app',
        'a.txt': '',
        'b.txt': '',
        'c.txt': '',
      }).map(([path, content]) => writeFile(join(ctx.context, path), content)),
    );

    await chmod(join(ctx.context, 'app.js'), 0o755);
    await symlink('app.js', join(ctx.context, 'start'));

    const entries = await listContextEntries(ctx.context, 'Dockerfile');

    const progress = {
      setTotal: mock<(bytes: number) => void>(),
      add: mock<(bytes: number) => void>(),
      finish: mock<() => void>(),
    };

    const packed = createContextStream(entries, progress, mock<(text: string) => void>());

    await Bun.write(ctx.tarPath, new Response(packed));

    runDockerBuild({
      dockerfile: join(ctx.context, 'dockerfile'),
      context: { dir: ctx.context },
      dest: ctx.fromDir,
    });

    runDockerBuild({
      dockerfile: 'dockerfile',
      context: { tarPath: ctx.tarPath },
      dest: ctx.fromTar,
    });

    const counted = await countTarBytes(entries);
    const fromDir = await listTree(ctx.fromDir);
    const fromTar = await listTree(ctx.fromTar);

    expect(counted).toBe(Bun.file(ctx.tarPath).size);
    expect(fromTar).toStrictEqual(fromDir);

    expect(fromTar).toStrictEqual([
      '.dockerignore',
      'Dockerfile.dockerignore',
      'a.txt',
      'app.js*',
      'c.txt',
      'dockerfile',
      'dockerfile.dockerignore',
      'start@',
    ]);
  },
  120_000,
);
