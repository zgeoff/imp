import { expect, test } from 'bun:test';
import { buildMockHostProbe } from './build-mock-host-probe';

test('it builds a default host probe', () => {
  const probe: unknown = buildMockHostProbe();

  expect(probe).toStrictEqual({
    info: expect.objectContaining({
      version: expect.any(String) as unknown,
      defaults: { memoryMib: expect.any(Number) as unknown, image: expect.any(String) as unknown },
      features: expect.objectContaining({ publicEgress: true }) as unknown,
    }) as unknown,
    identity: {
      kind: 'token',
      name: expect.any(String) as unknown,
      scope: 'manage',
      imps: null,
      grantable: [],
    },
    images: [expect.any(String) as unknown],
    imps: [],
    networks: [],
  });
});

test('it applies overrides on top of the defaults', () => {
  const probe: unknown = buildMockHostProbe({
    info: { version: '0.39.0', egress: { isEnforced: false } },
    identity: { scope: 'read' },
    images: ['base'],
    imps: ['dev'],
    networks: ['lab'],
  });

  expect(probe).toStrictEqual({
    info: expect.objectContaining({
      version: '0.39.0',
      egress: { isEnforced: false },
      storage: expect.objectContaining({ backend: 'xfs', isLow: false }) as unknown,
    }) as unknown,
    identity: {
      kind: 'token',
      name: expect.any(String) as unknown,
      scope: 'read',
      imps: null,
      grantable: [],
    },
    images: ['base'],
    imps: ['dev'],
    networks: ['lab'],
  });
});

test('it lists the info’s default image as the host’s one image', () => {
  const probe = buildMockHostProbe({ info: { defaults: { image: 'ubuntu' } } });

  expect(probe.images).toStrictEqual(['ubuntu']);
});

test('it leaves out the parts of the info an older impd lacks', () => {
  const probe = buildMockHostProbe({ withoutInfo: ['features', 'egress'] });

  expect(Object.keys(probe.info)).not.toIncludeAnyMembers(['features', 'egress']);
});

test('it lists no image for an info with no default image', () => {
  const probe = buildMockHostProbe({ withoutInfo: ['defaults'] });

  expect(probe.images).toStrictEqual([]);
});
