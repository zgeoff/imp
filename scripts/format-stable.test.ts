import { expect, test } from 'bun:test';
import { join } from 'node:path';

// The release job formats a release pull request once more at most
// (ci.yml). oxfmt 0.57.0 needed a second pass for this 0.29.0 entry, with
// a `($)` and a `${BASE}` in one paragraph
const REPO_ROOT = join(import.meta.dir, '..');

const CHANGELOG = `# Changelog

## [0.29.0](https://github.com/zgeoff/imp/compare/v0.28.1...v0.29.0) (2026-10-03)

### ⚠ BREAKING CHANGES

* **images:** imp image build refuses a Dockerfile with a variable ($) in FROM, such as FROM \${BASE}; write the base image literally.
`;

function format(source: string): string {
  const result = Bun.spawnSync(
    [join(REPO_ROOT, 'node_modules/.bin/oxfmt'), '--stdin-filepath=CHANGELOG.md'],
    { cwd: REPO_ROOT, stdin: Buffer.from(source) },
  );

  expect(result.exitCode).toBe(0);

  return result.stdout.toString();
}

test('one oxfmt pass settles a release changelog', () => {
  const once = format(CHANGELOG);

  expect(format(once)).toBe(once);
});
