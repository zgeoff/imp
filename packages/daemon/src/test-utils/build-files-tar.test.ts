import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFilesTar } from './build-files-tar';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'files-tar-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('it lists each file by its name', async () => {
  const ctx = await setupTest();

  const tar = buildFilesTar(ctx.dir, { hello: 'hi\n', other: 'there\n' });
  const listed = Bun.spawnSync(['tar', '-t', '-f', '-'], { stdin: tar }).stdout.toString();

  expect(listed).toBe('hello\nother\n');
});

test('it holds the content of each file', async () => {
  const ctx = await setupTest();

  const tar = buildFilesTar(ctx.dir, { hello: 'hi\n' });
  const content = Bun.spawnSync(['tar', '-x', '-O', '-f', '-', 'hello'], { stdin: tar }).stdout;

  expect(content.toString()).toBe('hi\n');
});

test('it writes each tree in a fresh directory, so the same name twice does not clash', async () => {
  const ctx = await setupTest();

  buildFilesTar(ctx.dir, { hello: 'one\n' });

  const tar = buildFilesTar(ctx.dir, { hello: 'two\n' });
  const content = Bun.spawnSync(['tar', '-x', '-O', '-f', '-', 'hello'], { stdin: tar }).stdout;

  expect(content.toString()).toBe('two\n');
});

// a name tar reads as an option of its own, which it refuses
test('it throws with tar exit code and stderr when tar fails', async () => {
  const ctx = await setupTest();

  expect(() => buildFilesTar(ctx.dir, { '--no-such-option': 'x\n' })).toThrowWithMessage(
    Error,
    /^tar exited 64: tar: unrecognized option '--no-such-option'/v,
  );
});
