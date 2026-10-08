import { expect, test } from 'bun:test';
import { buildMockSystemInfo } from '@imp/api/test-utils/build-mock-system-info';
import { invariant } from '@imp/test-utils/invariant';
import { requireFeature } from './require-feature';

test('it resolves when impd reports the feature on', () => {
  const info = buildMockSystemInfo({ features: { databaseCopy: true } });

  expect(
    requireFeature({ system: { info: () => Promise.resolve(info) } }, 'databaseCopy', 'copy it'),
  ).resolves.toBeUndefined();
});

test('it refuses when impd reports the feature off', () => {
  const info = buildMockSystemInfo({ features: { databaseCopy: false } });

  expect(
    requireFeature({ system: { info: () => Promise.resolve(info) } }, 'databaseCopy', 'copy it'),
  ).rejects.toThrowWithMessage(
    Error,
    'this impd is older than 0.30.0 and would copy it; nothing was changed. Upgrade impd, or use an older imp CLI',
  );
});

test('it refuses when impd does not name the feature', () => {
  const info = buildMockSystemInfo();

  invariant(info.features);

  const { sessionLog: _absent, ...others } = info.features;

  expect(
    requireFeature(
      { system: { info: () => Promise.resolve({ ...info, features: others }) } },
      'sessionLog',
      'read nothing',
    ),
  ).rejects.toThrowWithMessage(
    Error,
    'this impd has no session logs and would read nothing; nothing was changed. Upgrade impd, or use an older imp CLI',
  );
});

test('it refuses when impd reports no features at all', () => {
  const { features: _absent, ...info } = buildMockSystemInfo();

  expect(
    requireFeature({ system: { info: () => Promise.resolve(info) } }, 'grantableTokens', 'drop it'),
  ).rejects.toThrowWithMessage(
    Error,
    'this impd is older than 0.27.0 and would drop it; nothing was changed. Upgrade impd, or use an older imp CLI',
  );
});

test('it passes on a failed feature check as it came', () => {
  const failure = new Error('impd is down');

  expect(
    requireFeature({ system: { info: () => Promise.reject(failure) } }, 'databaseCopy', 'copy it'),
  ).rejects.toBe(failure);
});
