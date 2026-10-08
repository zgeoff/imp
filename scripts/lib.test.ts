import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSourcedFunction } from './test-utils/run-sourced-function';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-lib-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('#dev_image_tag gives a checkout the same tag every time', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  const first = runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/a/imp'] });
  const second = runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/a/imp'] });

  expect(first.exitCode).toBe(0);
  expect(first.stdout).toMatch(/^imp-host:dev-imp-[0-9a-f]{8}\n$/u);
  expect(second).toStrictEqual(first);
});

test('#dev_image_tag gives another checkout of the same name another tag', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  const one = runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/a/imp'] });
  const other = runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/b/imp'] });

  expect(other.stdout).toStartWith('imp-host:dev-imp-');
  expect(other.stdout).not.toBe(one.stdout);
});

test.each([['/w/My Work Tree'], ['/w/.hidden'], ['/w/wörk'], [`/w/${'x'.repeat(200)}`]])(
  '#dev_image_tag keeps the tag of %p to the characters and length Docker allows',
  (root) => {
    const script = new URL('lib.sh', import.meta.url).pathname;

    // Docker's tag grammar, after the imp-host repository
    expect(runSourcedFunction({ script, fn: 'dev_image_tag', args: [root] }).stdout).toMatch(
      /^imp-host:\w[\w.-]{0,127}\n$/u,
    );
  },
);

test('#dev_image_tag turns the blanks of a checkout name into dashes', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'dev_image_tag', args: ['/w/My Work Tree'] }).stdout,
  ).toMatch(/^imp-host:dev-My-Work-Tree-[0-9a-f]{8}\n$/u);
});

test('#dev_image_tag cuts a long checkout name to 40 characters', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  expect(
    runSourcedFunction({ script, fn: 'dev_image_tag', args: [`/w/${'x'.repeat(200)}`] }).stdout,
  ).toMatch(/^imp-host:dev-x{40}-[0-9a-f]{8}\n$/u);
});

test('#IMP_HOST_IMAGE defaults to the tag of the checkout lib.sh is in', () => {
  const script = new URL('lib.sh', import.meta.url).pathname;

  const root = realpathSync(new URL('..', import.meta.url).pathname);
  const image = runSourcedFunction({ script, fn: 'eval', args: ['printf %s "$IMP_HOST_IMAGE"'] });
  const tag = runSourcedFunction({ script, fn: 'dev_image_tag', args: [root] });

  expect(image.stdout).toBe(tag.stdout.trim());
});

test('#IMP_HOST_IMAGE defaults to the same tag for a checkout reached through a symlink', () => {
  const ctx = setupTest();
  const link = join(ctx.dir, 'linked-checkout');

  symlinkSync(realpathSync(new URL('..', import.meta.url).pathname), link);

  const linked = runSourcedFunction({
    script: join(link, 'scripts', 'lib.sh'),
    fn: 'eval',
    args: ['printf %s "$IMP_HOST_IMAGE"'],
  });

  const direct = runSourcedFunction({
    script: new URL('lib.sh', import.meta.url).pathname,
    fn: 'eval',
    args: ['printf %s "$IMP_HOST_IMAGE"'],
  });

  expect(direct.stdout).toStartWith('imp-host:dev-');
  expect(linked).toStrictEqual(direct);
});

test('#IMP_HOST_IMAGE keeps the value the environment sets', () => {
  expect(
    runSourcedFunction({
      script: new URL('lib.sh', import.meta.url).pathname,
      fn: 'eval',
      args: ['printf %s "$IMP_HOST_IMAGE"'],
      env: { IMP_HOST_IMAGE: 'imp-host:dev' },
    }),
  ).toStrictEqual({ exitCode: 0, stdout: 'imp-host:dev', stderr: '' });
});
