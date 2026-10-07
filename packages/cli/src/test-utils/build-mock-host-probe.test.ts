import { expect, test } from 'bun:test';
import { buildMockSystemInfo } from '@imp/api/test-utils/build-mock-system-info';
import { buildMockHostProbe } from './build-mock-host-probe';

test('it builds a default host probe', () => {
  const probe = buildMockHostProbe();
  const received: unknown = probe;

  expect(received).toStrictEqual({
    info: expect.objectContaining({ version: expect.any(String) as unknown }) as unknown,
    identity: {
      kind: 'token',
      name: expect.any(String) as unknown,
      scope: 'manage',
      imps: null,
      grantable: [],
    },
    images: [probe.info.defaults?.image],
    imps: [],
    networks: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  const info = buildMockSystemInfo({ defaults: { image: 'base' } });
  const probe: unknown = buildMockHostProbe({ info, imps: ['dev'], networks: ['lab'] });

  expect(probe).toStrictEqual({
    info,
    identity: {
      kind: 'token',
      name: expect.any(String) as unknown,
      scope: 'manage',
      imps: null,
      grantable: [],
    },
    images: ['base'],
    imps: ['dev'],
    networks: ['lab'],
  });
});

test('it lists no image for an info with no default image', () => {
  const probe = buildMockHostProbe({ info: buildMockSystemInfo({ defaults: { image: null } }) });

  expect(probe.images).toStrictEqual([]);
});
