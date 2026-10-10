import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandLinks } from './create-command-links';

function setupTest() {
  const bin = mkdtempSync(join(tmpdir(), 'create-command-links-'));

  onTestFinished(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  return { bin };
}

test('it links each named command into the directory', () => {
  const ctx = setupTest();

  createCommandLinks({ bin: ctx.bin, names: ['sh', 'cat'] });

  expect(readdirSync(ctx.bin)).toIncludeSameMembers(['sh', 'cat']);
});

test('it links commands that run with only the directory on PATH', () => {
  const ctx = setupTest();
  const note = join(ctx.bin, 'note.txt');

  writeFileSync(note, 'linked');
  createCommandLinks({ bin: ctx.bin, names: ['sh', 'cat'] });

  // cat is no shell builtin: sh finds it through PATH, which holds only the links
  const run = Bun.spawnSync([join(ctx.bin, 'sh'), '-c', `cat '${note}'`], {
    env: { PATH: ctx.bin },
  });

  expect({ stdout: run.stdout.toString(), exitCode: run.exitCode }).toStrictEqual({
    stdout: 'linked',
    exitCode: 0,
  });
});

test('it rejects a command that is not on PATH', () => {
  const ctx = setupTest();

  expect(() => {
    createCommandLinks({ bin: ctx.bin, names: ['imp-no-such-command'] });
  }).toThrowWithMessage(Error, 'imp-no-such-command is not on PATH');
});
