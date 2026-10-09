import { expect, test } from 'bun:test';
import { MoveHeaderSchema } from './move-header';

test('it fills the defaults of a cold header from a source before boots, leases or warm moves', () => {
  const result = MoveHeaderSchema.safeParse({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'open', allow: [] },
      grants: [],
      isIdentityResetPending: false,
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
    },
    checkpoints: [],
    streams: null,
  });

  expect(result.data).toStrictEqual({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'open', allow: [] },
      grants: [],
      isIdentityResetPending: false,
      isDiskGrowPending: false,
      coldBoots: [],
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
    },
    checkpoints: [],
    streams: null,
    warm: null,
  });
});

test('it reads the dates of a ZFS warm header with boots, leases and checkpoints', () => {
  const result = MoveHeaderSchema.safeParse({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 2,
      memoryMib: 512,
      maxMemoryMib: 2048,
      httpPort: 8080,
      diskBytes: 4096,
      cpu: { limit: 1.5, weight: 200 },
      egress: { mode: 'box', allow: ['github.com'] },
      grants: ['gh-token'],
      isIdentityResetPending: true,
      isDiskGrowPending: true,
      coldBoots: [
        {
          bootId: '00000000-0000-4000-8000-000000000001',
          cause: 'start',
          at: '2026-10-03T00:00:00.000Z',
        },
      ],
      leases: [
        {
          principal: 'tailnet:n1',
          label: 'job',
          display: 'laptop',
          remainingMs: 60_000,
          createdAt: '2026-10-03T00:00:00.000Z',
        },
      ],
    },
    image: {
      name: 'dev-tpl',
      ref: 'dev-tpl',
      digest: 'sha256:tpl',
      sizeBytes: 6,
      source: 'imp',
      sourceImp: 'base',
      isIncluded: true,
    },
    checkpoints: [{ label: 'before', createdAt: '2026-10-02T00:00:00.000Z', diskBytes: 2048 }],
    streams: [
      { checkpoint: 0, dataset: 0, base: null },
      { checkpoint: null, dataset: 0, base: 0 },
    ],
    warm: {
      move: {
        slot: 3,
        egressMode: 'box',
        snapshot: {
          firecrackerVersion: 'v1.17.0',
          snapshotVersion: 'v12.0.0',
          hostKernel: '6.8.0',
          cpuModel: 'AMD EPYC 9454P',
          cpuFlags: 'flags-sha',
          ipv6Prefix: null,
        },
        host: {
          dataDir: '/var/lib/imp',
          storage: 'zfs',
          subnet: '10.66.0.0/16',
          brokerPort: 7081,
          dns: ['1.1.1.1'],
        },
      },
      meta: {
        firecrackerVersion: 'v1.17.0',
        snapshotVersion: 'v12.0.0',
        hostKernel: '6.8.0',
        guestKernel: 'a'.repeat(64),
        systemDrive: 'b'.repeat(64),
        createdAt: 1_790_000_000_000,
        memoryMib: 512,
        ramMib: 512,
      },
      vm: null,
      isDriveIncluded: true,
      answers: [{ names: ['github.com'], address: '140.82.112.3', ttlS: 60 }],
    },
  });

  expect(result.data).toStrictEqual({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 2,
      memoryMib: 512,
      maxMemoryMib: 2048,
      httpPort: 8080,
      diskBytes: 4096,
      cpu: { limit: 1.5, weight: 200 },
      egress: { mode: 'box', allow: ['github.com'] },
      grants: ['gh-token'],
      isIdentityResetPending: true,
      isDiskGrowPending: true,
      coldBoots: [
        {
          bootId: '00000000-0000-4000-8000-000000000001',
          cause: 'start',
          at: '2026-10-03T00:00:00.000Z',
        },
      ],
      leases: [
        {
          principal: 'tailnet:n1',
          label: 'job',
          display: 'laptop',
          remainingMs: 60_000,
          createdAt: new Date('2026-10-03T00:00:00.000Z'),
        },
      ],
    },
    image: {
      name: 'dev-tpl',
      ref: 'dev-tpl',
      digest: 'sha256:tpl',
      sizeBytes: 6,
      source: 'imp',
      sourceImp: 'base',
      isIncluded: true,
    },
    checkpoints: [
      { label: 'before', createdAt: new Date('2026-10-02T00:00:00.000Z'), diskBytes: 2048 },
    ],
    streams: [
      { checkpoint: 0, dataset: 0, base: null },
      { checkpoint: null, dataset: 0, base: 0 },
    ],
    warm: {
      move: {
        slot: 3,
        egressMode: 'box',
        snapshot: {
          firecrackerVersion: 'v1.17.0',
          snapshotVersion: 'v12.0.0',
          hostKernel: '6.8.0',
          cpuModel: 'AMD EPYC 9454P',
          cpuFlags: 'flags-sha',
          ipv6Prefix: null,
        },
        host: {
          dataDir: '/var/lib/imp',
          storage: 'zfs',
          subnet: '10.66.0.0/16',
          brokerPort: 7081,
          dns: ['1.1.1.1'],
        },
      },
      meta: {
        firecrackerVersion: 'v1.17.0',
        snapshotVersion: 'v12.0.0',
        hostKernel: '6.8.0',
        guestKernel: 'a'.repeat(64),
        systemDrive: 'b'.repeat(64),
        createdAt: 1_790_000_000_000,
        memoryMib: 512,
        ramMib: 512,
      },
      vm: null,
      isDriveIncluded: true,
      answers: [{ names: ['github.com'], address: '140.82.112.3', ttlS: 60 }],
    },
  });
});

test.each([
  ['a hold with no end', { label: 'hold', remainingMs: null }],
  ['a lease with the longest time left', { label: 'job', remainingMs: 3_153_600_000_000 }],
])('it accepts %s', (_lease, fields) => {
  const lease = {
    principal: 'tailnet:n1',
    display: 'laptop',
    createdAt: '2026-10-03T00:00:00.000Z',
    ...fields,
  };

  const result = MoveHeaderSchema.safeParse({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'open', allow: [] },
      grants: [],
      isIdentityResetPending: false,
      leases: [lease],
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
    },
    checkpoints: [],
    streams: null,
  });

  expect(result.data?.imp.leases).toStrictEqual([
    { ...lease, createdAt: new Date('2026-10-03T00:00:00.000Z') },
  ]);
});

test.each([
  ['a version other than 1', { version: 2 }, ['version'], 'invalid_value'],
  [
    'a stream with a negative dataset',
    { streams: [{ checkpoint: null, dataset: -1, base: null }] },
    ['streams', 0, 'dataset'],
    'too_small',
  ],
  [
    'a checkpoint with no bytes',
    { checkpoints: [{ label: null, createdAt: '2026-10-02T00:00:00.000Z', diskBytes: 0 }] },
    ['checkpoints', 0, 'diskBytes'],
    'too_small',
  ],
  [
    'a checkpoint with no date',
    { checkpoints: [{ label: null, createdAt: 'never', diskBytes: 1024 }] },
    ['checkpoints', 0, 'createdAt'],
    'invalid_type',
  ],
])('it rejects a header with %s', (_change, fields, path, code) => {
  const result = MoveHeaderSchema.safeParse({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'open', allow: [] },
      grants: [],
      isIdentityResetPending: false,
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
    },
    checkpoints: [],
    streams: null,
    ...fields,
  });

  expect(result.error?.issues).toPartiallyContain({ path, code });
});

test.each([
  ['an id that is not a UUID', { id: '../x' }, ['imp', 'id'], 'invalid_format'],
  ['no vCPUs', { vcpus: 0 }, ['imp', 'vcpus'], 'too_small'],
  [
    'five cold boots',
    {
      coldBoots: Array.from({ length: 5 }, () => ({
        bootId: '00000000-0000-4000-8000-000000000001',
        cause: 'start',
        at: '2026-10-03T00:00:00.000Z',
      })),
    },
    ['imp', 'coldBoots'],
    'too_big',
  ],
  [
    'a cold boot whose id is not a UUID',
    { coldBoots: [{ bootId: '../x', cause: 'start', at: '2026-10-03T00:00:00.000Z' }] },
    ['imp', 'coldBoots', 0, 'bootId'],
    'invalid_format',
  ],
  [
    'a cold boot with an unknown cause',
    {
      coldBoots: [
        {
          bootId: '00000000-0000-4000-8000-000000000001',
          cause: 'magic',
          at: '2026-10-03T00:00:00.000Z',
        },
      ],
    },
    ['imp', 'coldBoots', 0, 'cause'],
    'invalid_value',
  ],
  [
    '1025 leases',
    {
      leases: Array.from({ length: 1025 }, () => ({
        principal: 'tailnet:n1',
        label: 'job',
        display: 'laptop',
        remainingMs: 60_000,
        createdAt: '2026-10-03T00:00:00.000Z',
      })),
    },
    ['imp', 'leases'],
    'too_big',
  ],
])('it rejects an imp with %s', (_change, fields, path, code) => {
  const result = MoveHeaderSchema.safeParse({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'open', allow: [] },
      grants: [],
      isIdentityResetPending: false,
      ...fields,
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
    },
    checkpoints: [],
    streams: null,
  });

  expect(result.error?.issues).toPartiallyContain({ path, code });
});

test.each([
  ['a negative time left', { remainingMs: -1 }, 'remainingMs', 'too_small'],
  ['a fractional time left', { remainingMs: 1.5 }, 'remainingMs', 'invalid_type'],
  ['over a century left', { remainingMs: 3_153_600_000_001 }, 'remainingMs', 'too_big'],
  ['a label with a space', { label: 'a b' }, 'label', 'invalid_format'],
  ['a 65-character label', { label: 'x'.repeat(65) }, 'label', 'invalid_format'],
  ['an empty owner', { principal: '' }, 'principal', 'too_small'],
  ['a 257-character owner', { principal: 'x'.repeat(257) }, 'principal', 'too_big'],
  ['a 257-character display name', { display: 'x'.repeat(257) }, 'display', 'too_big'],
])('it rejects a lease with %s', (_change, fields, field, code) => {
  const result = MoveHeaderSchema.safeParse({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'open', allow: [] },
      grants: [],
      isIdentityResetPending: false,
      leases: [
        {
          principal: 'tailnet:n1',
          label: 'job',
          display: 'laptop',
          remainingMs: 60_000,
          createdAt: '2026-10-03T00:00:00.000Z',
          ...fields,
        },
      ],
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
    },
    checkpoints: [],
    streams: null,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['imp', 'leases', 0, field], code });
});

test.each([
  ['a negative size', { sizeBytes: -1 }, 'sizeBytes', 'too_small'],
  ['an unknown source', { source: 'tarball' }, 'source', 'invalid_value'],
])('it rejects an image with %s', (_change, fields, field, code) => {
  const result = MoveHeaderSchema.safeParse({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'open', allow: [] },
      grants: [],
      isIdentityResetPending: false,
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
      ...fields,
    },
    checkpoints: [],
    streams: null,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['image', field], code });
});

test.each([
  [
    'a system drive that is not a sha256',
    {
      meta: {
        firecrackerVersion: 'v1.17.0',
        snapshotVersion: 'v12.0.0',
        hostKernel: '6.8.0',
        guestKernel: 'a'.repeat(64),
        systemDrive: 'drive.ext4',
        createdAt: 1_790_000_000_000,
        memoryMib: 512,
        ramMib: 512,
      },
    },
    ['warm', 'meta', 'systemDrive'],
    'invalid_format',
  ],
  [
    'a negative slot',
    {
      move: {
        slot: -1,
        egressMode: 'box',
        snapshot: {
          firecrackerVersion: 'v1.17.0',
          snapshotVersion: 'v12.0.0',
          hostKernel: '6.8.0',
          cpuModel: 'AMD EPYC 9454P',
          cpuFlags: 'flags-sha',
          ipv6Prefix: null,
        },
        host: {
          dataDir: '/var/lib/imp',
          storage: 'xfs',
          subnet: '10.66.0.0/16',
          brokerPort: 7081,
          dns: ['1.1.1.1'],
        },
      },
    },
    ['warm', 'move', 'slot'],
    'too_small',
  ],
  [
    'an answer with no time to live',
    { answers: [{ names: ['github.com'], address: '140.82.112.3', ttlS: 0 }] },
    ['warm', 'answers', 0, 'ttlS'],
    'too_small',
  ],
])('it rejects a warm move with %s', (_change, fields, path, code) => {
  const result = MoveHeaderSchema.safeParse({
    version: 1,
    imp: {
      id: '0199a000-0000-7000-8000-000000000001',
      name: 'dev',
      vcpus: 1,
      memoryMib: 256,
      httpPort: 8080,
      diskBytes: 1024,
      cpu: { limit: null, weight: 100 },
      egress: { mode: 'box', allow: [] },
      grants: [],
      isIdentityResetPending: false,
    },
    image: {
      name: 'ubuntu',
      ref: 'ubuntu:latest',
      digest: 'sha256:ubuntu',
      sizeBytes: 6,
      source: 'oci',
      sourceImp: null,
      isIncluded: false,
    },
    checkpoints: [],
    streams: null,
    warm: {
      move: {
        slot: 3,
        egressMode: 'box',
        snapshot: {
          firecrackerVersion: 'v1.17.0',
          snapshotVersion: 'v12.0.0',
          hostKernel: '6.8.0',
          cpuModel: 'AMD EPYC 9454P',
          cpuFlags: 'flags-sha',
          ipv6Prefix: null,
        },
        host: {
          dataDir: '/var/lib/imp',
          storage: 'xfs',
          subnet: '10.66.0.0/16',
          brokerPort: 7081,
          dns: ['1.1.1.1'],
        },
      },
      meta: {
        firecrackerVersion: 'v1.17.0',
        snapshotVersion: 'v12.0.0',
        hostKernel: '6.8.0',
        guestKernel: 'a'.repeat(64),
        systemDrive: 'b'.repeat(64),
        createdAt: 1_790_000_000_000,
        memoryMib: 512,
        ramMib: 512,
      },
      vm: null,
      isDriveIncluded: false,
      answers: [],
      ...fields,
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path, code });
});
