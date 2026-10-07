import { expect, test } from 'bun:test';

// The release job formats a release pull request once more at most (ci.yml). oxfmt 0.57.0
// needed a second pass for this 0.29.0 entry, with a `($)` and a `${BASE}` in one paragraph.
test('it settles a release changelog in one oxfmt pass', () => {
  const oxfmt = [
    new URL('../node_modules/.bin/oxfmt', import.meta.url).pathname,
    '--stdin-filepath=CHANGELOG.md',
  ];

  const cwd = new URL('..', import.meta.url).pathname;

  const once = Bun.spawnSync(oxfmt, {
    cwd,
    stdin: Buffer.from(
      '# Changelog\n\n' +
        '## [0.29.0](https://github.com/zgeoff/imp/compare/v0.28.1...v0.29.0) (2026-10-03)\n\n' +
        '### ⚠ BREAKING CHANGES\n\n' +
        '* **images:** imp image build refuses a Dockerfile with a variable ($) in FROM, ' +
        `such as FROM \${BASE}; write the base image literally.\n`,
    ),
  });

  const twice = Bun.spawnSync(oxfmt, { cwd, stdin: once.stdout });

  expect(once.exitCode).toBe(0);
  expect(twice.exitCode).toBe(0);
  expect(twice.stdout.toString()).toBe(once.stdout.toString());
});
