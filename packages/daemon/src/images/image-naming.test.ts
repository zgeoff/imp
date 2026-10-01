import { expect, test } from 'bun:test';
import { buildImageRuntimeConfig, deriveImageName } from './image-naming';

test('it derives a name from the last repository segment', () => {
  expect(deriveImageName('ubuntu:24.04')).toBe('ubuntu');
  expect(deriveImageName('ghcr.io/acme/web-app:1.2')).toBe('web-app');
  expect(deriveImageName('localhost:5000/My_Image@sha256:abcd')).toBe('my-image');
  expect(deriveImageName('imp/base')).toBe('base');
});

test('it rejects a ref with no usable name', () => {
  expect(() => deriveImageName('_:1')).toThrow('pass a name');
  expect(() => deriveImageName('123')).toThrow('pass a name');
});

test('it maps the OCI config to the agent image config', () => {
  expect(
    buildImageRuntimeConfig({ Env: ['PATH=/bin'], WorkingDir: '/app', User: 'node', Cmd: ['x'] }),
  ).toEqual({ env: ['PATH=/bin'], workdir: '/app', user: 'node' });

  expect(buildImageRuntimeConfig(null)).toEqual({ env: [], workdir: '', user: '' });
  expect(buildImageRuntimeConfig({ Env: null })).toEqual({ env: [], workdir: '', user: '' });
});
