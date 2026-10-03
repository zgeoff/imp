import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const LIB = new URL('lib.sh', import.meta.url).pathname;

const dir = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'imp-lib-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// what scripts/lib.sh sets IMP_HOST_IMAGE to, sourced from lib with this env
function readHostImage(env: Readonly<Record<string, string>> = {}, lib = LIB): string {
  const result = Bun.spawnSync(
    ['bash', '-c', 'source "$1" && printf "%s" "$IMP_HOST_IMAGE"', 'bash', lib],
    { env: { PATH: process.env['PATH'] ?? '', ...env } },
  );

  expect(result.exitCode).toBe(0);

  return result.stdout.toString();
}

function readDevImageTag(root: string): string {
  const result = Bun.spawnSync([
    'bash',
    '-c',
    'source "$1" && dev_image_tag "$2"',
    'bash',
    LIB,
    root,
  ]);

  expect(result.exitCode).toBe(0);

  return result.stdout.toString().trim();
}

// Docker's tag grammar, after the imp-host repository
const TAG = /^imp-host:[\w][\w.-]{0,127}$/u;

test('each checkout gets its own tag, the same every time', () => {
  const first = readDevImageTag('/a/imp');

  expect(first).toMatch(/^imp-host:dev-imp-[0-9a-f]{8}$/u);
  expect(readDevImageTag('/a/imp')).toBe(first);
  expect(readDevImageTag('/b/imp')).not.toBe(first);
});

test('the tag keeps to the characters and length Docker allows', () => {
  for (const root of ['/w/My Work Tree', '/w/.hidden', '/w/wörk', `/w/${'x'.repeat(200)}`]) {
    expect(readDevImageTag(root)).toMatch(TAG);
  }

  expect(readDevImageTag('/w/My Work Tree')).toStartWith('imp-host:dev-My-Work-Tree-');
  expect(readDevImageTag(`/w/${'x'.repeat(200)}`)).toStartWith(`imp-host:dev-${'x'.repeat(40)}-`);
});

test('the default is the tag of the checkout lib.sh is in', () => {
  const root = realpathSync(new URL('..', import.meta.url).pathname);

  expect(readHostImage()).toBe(readDevImageTag(root));
});

test('a checkout reached through a symlink has the same tag', () => {
  const link = join(dir, 'linked-checkout');

  symlinkSync(realpathSync(new URL('..', import.meta.url).pathname), link);

  expect(readHostImage({}, join(link, 'scripts', 'lib.sh'))).toBe(readHostImage());
});

test('IMP_HOST_IMAGE overrides the derived tag', () => {
  expect(readHostImage({ IMP_HOST_IMAGE: 'imp-host:dev' })).toBe('imp-host:dev');
});
