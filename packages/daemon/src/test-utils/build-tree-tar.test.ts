import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTreeTar } from './build-tree-tar';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'tree-tar-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it archives the tree make writes from its root', async () => {
  const ctx = await setupTest();

  const tar = buildTreeTar(ctx.dir, (tree) => {
    writeFileSync(join(tree, 'hello'), 'hi\n');
  });

  const listed = Bun.spawnSync(['tar', '-t', '-f', '-'], { stdin: tar }).stdout.toString();

  expect(listed).toBe('./\n./hello\n');
});

test('it owns each entry by root', async () => {
  const ctx = await setupTest();

  const tar = buildTreeTar(ctx.dir, (tree) => {
    writeFileSync(join(tree, 'hello'), 'hi\n');
  });

  const listed = Bun.spawnSync(['tar', '-t', '-v', '--numeric-owner', '-f', '-'], {
    stdin: tar,
  }).stdout.toString();

  expect(listed.trimEnd().split('\n')).toSatisfyAll((line: string) => line.includes(' 0/0 '));
});

test('it passes its tar arguments to tar', async () => {
  const ctx = await setupTest();

  const tar = buildTreeTar(
    ctx.dir,
    (tree) => {
      writeFileSync(join(tree, 'kept'), 'k\n');
      writeFileSync(join(tree, 'skipped'), 's\n');
    },
    ['--exclude=./skipped'],
  );

  const listed = Bun.spawnSync(['tar', '-t', '-f', '-'], { stdin: tar }).stdout.toString();

  expect(listed).toBe('./\n./kept\n');
});

test('it throws with tar exit code and stderr when tar fails', async () => {
  const ctx = await setupTest();

  expect(() =>
    buildTreeTar(
      ctx.dir,
      (tree) => {
        writeFileSync(join(tree, 'hello'), 'hi\n');
      },
      ['--no-such-option'],
    ),
  ).toThrowWithMessage(Error, /^tar exited 64: tar: unrecognized option '--no-such-option'/v);
});

test('it removes the tree when tar fails', async () => {
  const ctx = await setupTest();

  expect(() =>
    buildTreeTar(
      ctx.dir,
      (tree) => {
        writeFileSync(join(tree, 'hello'), 'hi\n');
      },
      ['--no-such-option'],
    ),
  ).toThrow();

  const left = await readdir(ctx.dir);

  expect(left).toStrictEqual([]);
});

test('it removes the tree once it is archived', async () => {
  const ctx = await setupTest();

  buildTreeTar(ctx.dir, (tree) => {
    writeFileSync(join(tree, 'hello'), 'hi\n');
  });

  const left = await readdir(ctx.dir);

  expect(left).toStrictEqual([]);
});
