import { expect, test } from 'bun:test';
import { DOCKERFILE_FRONTEND } from './dockerfile-frontend';

test('it pins the frontend that host/Dockerfile names on its syntax line', async () => {
  const dockerfile = await Bun.file(new URL('../../../../host/Dockerfile', import.meta.url)).text();

  expect(dockerfile).toStartWith(`# syntax=${DOCKERFILE_FRONTEND}\n`);
});
