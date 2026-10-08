import { expect, test } from 'bun:test';
import { buildImageRuntimeConfig, deriveImageName } from './image-naming';

test.each([
  ['ubuntu:24.04', 'ubuntu'],
  ['ghcr.io/acme/web-app:1.2', 'web-app'],
  ['localhost:5000/My_Image@sha256:abcd', 'my-image'],
  ['imp/base', 'base'],
])('#deriveImageName derives the name of %s from its last repository segment', (ref, name) => {
  expect(deriveImageName(ref)).toBe(name);
});

test.each([['_:1'], ['123']])(
  '#deriveImageName refuses to derive a name from %s, which has none',
  (ref) => {
    expect(() => deriveImageName(ref)).toThrowWithMessage(
      Error,
      `cannot derive an image name from ${ref}; pass a name`,
    );
  },
);

test('#buildImageRuntimeConfig maps the OCI config to the agent image config', () => {
  expect(
    buildImageRuntimeConfig({ Env: ['PATH=/bin'], WorkingDir: '/app', User: 'node', Cmd: ['x'] }),
  ).toStrictEqual({ env: ['PATH=/bin'], workdir: '/app', user: 'node' });
});

test('#buildImageRuntimeConfig maps a missing OCI config to an empty agent image config', () => {
  expect(buildImageRuntimeConfig(null)).toStrictEqual({ env: [], workdir: '', user: '' });
});

test('#buildImageRuntimeConfig maps a null Env to no environment', () => {
  expect(buildImageRuntimeConfig({ Env: null })).toStrictEqual({ env: [], workdir: '', user: '' });
});

test('#buildImageRuntimeConfig refuses an OCI config whose Env is not a list of strings', () => {
  const building = Promise.try(() => buildImageRuntimeConfig({ Env: 'A=1' }));

  expect(building).rejects.toMatchObject({ issues: [{ path: ['Env'], code: 'invalid_type' }] });
});
