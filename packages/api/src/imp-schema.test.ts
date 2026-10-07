import { expect, test } from 'bun:test';
import {
  ForkResultSchema,
  GrantNotCopiedReasonSchema,
  GrantNotCopiedSchema,
  ImpKindSchema,
  ImpSchema,
  ImpStateSchema,
} from './imp-schema';

test.each(['creating', 'running', 'sleeping', 'stopped', 'error'])(
  '#ImpStateSchema accepts the %s state',
  (input) => {
    expect(ImpStateSchema.safeParse(input).data).toBe(input);
  },
);

test.each(['paused'])('#ImpStateSchema rejects the unknown state %s', (input) => {
  const result = ImpStateSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test.each(['user', 'builder'])('#ImpKindSchema accepts the %s kind', (input) => {
  expect(ImpKindSchema.safeParse(input).data).toBe(input);
});

test.each(['system'])('#ImpKindSchema rejects the unknown kind %s', (input) => {
  const result = ImpKindSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test('#ImpSchema accepts an imp without its optional fields', () => {
  const payload = {
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  } as const;

  expect(ImpSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImpSchema accepts an imp with every optional field', () => {
  const payload = {
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    kind: 'user',
    maxMemoryMib: 4096,
    pluggedMib: 0,
    diskUsage: {
      exclusiveBytes: 1024,
      sharedBytes: 2048,
      measuredAt: new Date('2026-01-02T04:05:06.000Z'),
      isPartial: false,
      isUpperBound: true,
    },
    public: { auth: 'token' },
    ramMib: 512,
    rssMib: 600,
    sleptAt: new Date('2026-01-02T04:05:06.000Z'),
    holdUntil: new Date('2026-01-02T04:05:06.000Z'),
    leases: {
      leases: [
        {
          name: 'dev',
          owner: { principal: 'token:1', display: 'laptop', label: 'hold' },
          until: null,
        },
      ],
      otherCount: 0,
    },
    error: 'boot failed',
    sessions: 2,
    coldBootReason: 'kernel changed',
    agentSilentSince: new Date('2026-01-02T04:05:06.000Z'),
    outdated: ['kernel', 'agent'],
    cpu: { limit: 1.5, weight: 100 },
    resources: {
      wakeCount: 3,
      awakeMs: 60_000,
      sample: {
        measuredAt: new Date('2026-01-02T04:05:06.000Z'),
        since: new Date('2026-01-02T03:04:05.000Z'),
        cpuPercent: 150,
        cpuThrottledMs: 0,
        netRxBytes: 10,
        netTxBytes: 20,
      },
    },
    move: 'sending',
  } as const;

  expect(ImpSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImpSchema rejects a name that is not a valid name', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'Dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['name'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#ImpSchema rejects an image that is not a valid name', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'Base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['image'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#ImpSchema rejects a state outside the state list', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'paused',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['state'] }));
});

test('#ImpSchema rejects a kind outside the kind list', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    kind: 'system',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['kind'] }));
});

test('#ImpSchema rejects zero vcpus', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 0,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['vcpus'] }));
});

test('#ImpSchema rejects a fractional vcpu count', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 1.5,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['vcpus'] }));
});

test('#ImpSchema rejects zero memory', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 0,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['memoryMib'] }));
});

test('#ImpSchema rejects a zero memory ceiling', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    maxMemoryMib: 0,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['maxMemoryMib'] }),
  );
});

test('#ImpSchema rejects negative plugged memory', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    pluggedMib: -1,
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['pluggedMib'] }),
  );
});

test('#ImpSchema rejects a zero disk size', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 0,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['diskMib'] }));
});

test('#ImpSchema rejects an ip that is not IPv4', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: 'fd00::2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['ip'] }));
});

test('#ImpSchema rejects a negative slot', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: -1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['slot'] }));
});

test('#ImpSchema rejects a zero port', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 0,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['port'] }));
});

test('#ImpSchema rejects a zero HTTP port', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 0,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['httpPort'] }));
});

test('#ImpSchema rejects a url that is not a URL', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['url'] }));
});

test('#ImpSchema rejects a public auth outside the auth list', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    public: { auth: 'password' },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['public', 'auth'] }),
  );
});

test('#ImpSchema rejects negative RAM', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    ramMib: -1,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['ramMib'] }));
});

test('#ImpSchema rejects negative resident memory', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    rssMib: -1,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['rssMib'] }));
});

test('#ImpSchema rejects a negative session count', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    sessions: -1,
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['sessions'] }));
});

test('#ImpSchema rejects an outdated part outside the part list', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    outdated: ['bios'],
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['outdated', 0] }),
  );
});

test('#ImpSchema rejects a zero CPU limit', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    cpu: { limit: 0, weight: 100 },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['cpu', 'limit'] }),
  );
});

test('#ImpSchema rejects a fractional CPU weight', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    cpu: { limit: null, weight: 1.5 },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['cpu', 'weight'] }),
  );
});

test('#ImpSchema rejects a move state outside the state list', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    move: 'paused',
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['move'] }));
});

test('#ImpSchema rejects a negative exclusive disk usage', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    diskUsage: {
      exclusiveBytes: -1,
      sharedBytes: 2048,
      measuredAt: new Date('2026-01-02T04:05:06.000Z'),
      isPartial: false,
      isUpperBound: false,
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['diskUsage', 'exclusiveBytes'] }),
  );
});

test('#ImpSchema rejects a negative wake count', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    resources: { wakeCount: -1, awakeMs: 0 },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['resources', 'wakeCount'] }),
  );
});

test('#ImpSchema rejects a negative CPU percent in a sample', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    resources: {
      wakeCount: 0,
      awakeMs: 0,
      sample: {
        measuredAt: new Date('2026-01-02T04:05:06.000Z'),
        since: new Date('2026-01-02T03:04:05.000Z'),
        cpuPercent: -1,
        cpuThrottledMs: 0,
        netRxBytes: 0,
        netTxBytes: 0,
      },
    },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['resources', 'sample', 'cpuPercent'] }),
  );
});

test('#ImpSchema rejects a negative count of other leases', () => {
  const result = ImpSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    leases: { leases: [], otherCount: -1 },
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['leases', 'otherCount'] }),
  );
});

test.each(['not-grantable', 'clash', 'no-secret'])(
  '#GrantNotCopiedReasonSchema accepts the %s reason',
  (input) => {
    expect(GrantNotCopiedReasonSchema.safeParse(input).data).toBe(input);
  },
);

test.each(['expired'])('#GrantNotCopiedReasonSchema rejects the unknown reason %s', (input) => {
  const result = GrantNotCopiedReasonSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: [] }));
});

test('#GrantNotCopiedSchema accepts a secret and a reason', () => {
  const payload = { secret: 'github', reason: 'clash' } as const;

  expect(GrantNotCopiedSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#GrantNotCopiedSchema rejects a secret that is not a valid secret name', () => {
  const result = GrantNotCopiedSchema.safeParse({ secret: 'GitHub', reason: 'clash' });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: ['secret'],
      message:
        'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
    }),
  );
});

test('#GrantNotCopiedSchema rejects a reason outside the reason list', () => {
  const result = GrantNotCopiedSchema.safeParse({ secret: 'github', reason: 'expired' });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['reason'] }));
});

test('#ForkResultSchema accepts a fork from an impd before the grants report', () => {
  const payload = {
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
  } as const;

  expect(ForkResultSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ForkResultSchema accepts a fork with grants it did not get', () => {
  const payload = {
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    grantsNotCopied: [{ secret: 'github', reason: 'not-grantable' }],
  } as const;

  expect(ForkResultSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ForkResultSchema accepts a fork whose grant copy failed', () => {
  const payload = {
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    grantsNotCopied: [],
    grantsError: 'the database is locked',
  } as const;

  expect(ForkResultSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ForkResultSchema rejects a grant reason outside the reason list', () => {
  const result = ForkResultSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 2,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    grantsNotCopied: [{ secret: 'github', reason: 'expired' }],
  });

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: ['grantsNotCopied', 0, 'reason'] }),
  );
});

test('#ForkResultSchema rejects a fork that is not a valid imp', () => {
  const result = ForkResultSchema.safeParse({
    id: 'imp-1',
    name: 'dev',
    image: 'base',
    state: 'running',
    vcpus: 0,
    memoryMib: 1024,
    diskMib: 4096,
    ip: '10.0.0.2',
    slot: 1,
    port: 7001,
    httpPort: 8080,
    url: 'https://dev.example.com',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    lastActiveAt: new Date('2026-01-02T04:05:06.000Z'),
    grantsNotCopied: [{ secret: 'github', reason: 'not-grantable' }],
  });

  expect(result.error?.issues).toPartiallyContain(expect.objectContaining({ path: ['vcpus'] }));
});
