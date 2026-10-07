import { expect, test } from 'bun:test';
import { envOriginals } from './env-originals';
import { updateEnv } from './update-env';

test('it keeps the value a variable held before its first override across repeated overrides', () => {
  updateEnv('IMP_TEST_ENV_ORIGINALS_HELD', 'first');
  updateEnv('IMP_TEST_ENV_ORIGINALS_HELD', 'second');

  expect(envOriginals).toStrictEqual(new Map([['IMP_TEST_ENV_ORIGINALS_HELD', undefined]]));
});

test('it records the value a set variable held before its override', () => {
  const original = process.env['PATH'];

  updateEnv('PATH', '/nowhere');

  expect(envOriginals).toStrictEqual(new Map([['PATH', original]]));
});
