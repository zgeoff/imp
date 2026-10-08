import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('it refuses to start without IMP_HOST_IMAGE', () => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: { PATH: process.env['PATH'] ?? '', IMP_HOST_IMAGE: '' },
  });

  expect(result.exitCode).not.toBe(0);

  expect(result.stderr.toString()).toInclude(
    'IMP_HOST_IMAGE is not set; set it to the image this proxy runs from',
  );
});

// the values impd itself refuses, so the two never disagree
test.each([
  ['IMP_BUILD_ISOLATION', 'none', 'IMP_BUILD_ISOLATION is none, not imp or host'],
  [
    'IMP_BUILD_IMAGE',
    'busybox:1.37',
    'IMP_BUILD_IMAGE is busybox:1.37, not an image by digest, <ref>@sha256:<hex>',
  ],
  ['IMP_BUILD_CONTEXT_MAX_MIB', 'lots', 'IMP_BUILD_CONTEXT_MAX_MIB is lots, not a count'],
  ['IMP_BUILD_CONTEXT_MAX_MIB', '0', 'IMP_BUILD_CONTEXT_MAX_MIB is 0, not a count'],
])('it refuses to start with %s=%s', (key, value, message) => {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'main.ts')], {
    env: { PATH: process.env['PATH'] ?? '', IMP_HOST_IMAGE: 'x', [key]: value },
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toInclude(message);
});
