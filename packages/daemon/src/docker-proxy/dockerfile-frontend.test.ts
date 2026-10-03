import { expect, test } from 'bun:test';
import { DOCKERFILE_FRONTEND } from './dockerfile-frontend';

test('image builds run the frontend host/Dockerfile names', async () => {
  const dockerfile = await Bun.file(new URL('../../../../host/Dockerfile', import.meta.url)).text();

  expect(dockerfile.split('\n')[0]).toBe(`# syntax=${DOCKERFILE_FRONTEND}`);
});
