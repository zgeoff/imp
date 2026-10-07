import { expect, test } from 'bun:test';
import {
  MovePlanSchema,
  MoveStateSchema,
  MoveStatusSchema,
  MoveTicketSchema,
  PeerUrlSchema,
  WarmHostSchema,
  WarmMoveSchema,
} from './move-schema';

test.each(['sending', 'moved', 'receiving'])('#MoveStateSchema accepts the %s state', (input) => {
  expect(MoveStateSchema.safeParse(input).data).toBe(input);
});

test('#MoveStateSchema rejects the unknown state sent', () => {
  const result = MoveStateSchema.safeParse('sent');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_value' });
});

test.each(['http://100.64.0.2:7070', 'https://100.64.0.2:7070/impd'])(
  '#PeerUrlSchema accepts the URL %s',
  (input) => {
    expect(PeerUrlSchema.safeParse(input).data).toBe(input);
  },
);

test.each(['ftp://100.64.0.2', '100.64.0.2:7070'])('#PeerUrlSchema rejects the URL %s', (input) => {
  const result = PeerUrlSchema.safeParse(input);

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'invalid_format' });
});

test('#WarmHostSchema accepts a host', () => {
  const payload = {
    firecrackerVersion: '1.12.0',
    snapshotVersion: '6.0.0',
    hostKernel: '6.6.87',
    cpuModel: 'AMD EPYC',
    cpuFlags: 'avx2 sse4_2',
    dataDir: '/data',
    storage: 'xfs',
    subnet: '10.0.0.0/16',
    slotCount: 64,
    brokerPort: 7443,
    dns: ['1.1.1.1'],
  } as const;

  expect(WarmHostSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#WarmHostSchema rejects a storage outside the storage list', () => {
  const result = WarmHostSchema.safeParse({
    firecrackerVersion: '1.12.0',
    snapshotVersion: '6.0.0',
    hostKernel: '6.6.87',
    cpuModel: 'AMD EPYC',
    cpuFlags: 'avx2 sse4_2',
    dataDir: '/data',
    storage: 'btrfs',
    subnet: '10.0.0.0/16',
    slotCount: 64,
    brokerPort: 7443,
    dns: ['1.1.1.1'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['storage'], code: 'invalid_value' });
});

test('#WarmHostSchema rejects a zero slot count', () => {
  const result = WarmHostSchema.safeParse({
    firecrackerVersion: '1.12.0',
    snapshotVersion: '6.0.0',
    hostKernel: '6.6.87',
    cpuModel: 'AMD EPYC',
    cpuFlags: 'avx2 sse4_2',
    dataDir: '/data',
    storage: 'xfs',
    subnet: '10.0.0.0/16',
    slotCount: 0,
    brokerPort: 7443,
    dns: ['1.1.1.1'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['slotCount'], code: 'too_small' });
});

test('#WarmHostSchema rejects a zero broker port', () => {
  const result = WarmHostSchema.safeParse({
    firecrackerVersion: '1.12.0',
    snapshotVersion: '6.0.0',
    hostKernel: '6.6.87',
    cpuModel: 'AMD EPYC',
    cpuFlags: 'avx2 sse4_2',
    dataDir: '/data',
    storage: 'xfs',
    subnet: '10.0.0.0/16',
    slotCount: 64,
    brokerPort: 0,
    dns: ['1.1.1.1'],
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['brokerPort'], code: 'too_small' });
});

test('#WarmMoveSchema accepts the side of a move that a sleeping imp sends', () => {
  const payload = {
    slot: 3,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: '1.12.0',
      snapshotVersion: '6.0.0',
      hostKernel: '6.6.87',
      cpuModel: 'AMD EPYC',
      cpuFlags: 'avx2',
      ipv6Prefix: null,
    },
    host: {
      dataDir: '/data',
      storage: 'zfs',
      subnet: '10.0.0.0/16',
      brokerPort: 7443,
      dns: ['1.1.1.1'],
    },
  } as const;

  expect(WarmMoveSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#WarmMoveSchema rejects a negative slot', () => {
  const result = WarmMoveSchema.safeParse({
    slot: -1,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: '1.12.0',
      snapshotVersion: '6.0.0',
      hostKernel: '6.6.87',
      cpuModel: 'AMD EPYC',
      cpuFlags: 'avx2',
      ipv6Prefix: null,
    },
    host: {
      dataDir: '/data',
      storage: 'zfs',
      subnet: '10.0.0.0/16',
      brokerPort: 7443,
      dns: ['1.1.1.1'],
    },
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['slot'], code: 'too_small' });
});

test('#WarmMoveSchema rejects a host storage outside the storage list', () => {
  const result = WarmMoveSchema.safeParse({
    slot: 3,
    egressMode: 'open',
    snapshot: {
      firecrackerVersion: '1.12.0',
      snapshotVersion: '6.0.0',
      hostKernel: '6.6.87',
      cpuModel: 'AMD EPYC',
      cpuFlags: 'avx2',
      ipv6Prefix: null,
    },
    host: {
      dataDir: '/data',
      storage: 'btrfs',
      subnet: '10.0.0.0/16',
      brokerPort: 7443,
      dns: ['1.1.1.1'],
    },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['host', 'storage'],
    code: 'invalid_value',
  });
});

test('#MovePlanSchema accepts a cold plan', () => {
  const payload = { bytes: 4096, checkpoints: 2, warm: null } as const;

  expect(MovePlanSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#MovePlanSchema accepts a warm plan', () => {
  const payload = {
    bytes: 4096,
    checkpoints: 2,
    warm: {
      slot: 3,
      egressMode: 'open',
      snapshot: {
        firecrackerVersion: '1.12.0',
        snapshotVersion: '6.0.0',
        hostKernel: '6.6.87',
        cpuModel: 'AMD EPYC',
        cpuFlags: 'avx2',
        ipv6Prefix: null,
      },
      host: {
        dataDir: '/data',
        storage: 'zfs',
        subnet: '10.0.0.0/16',
        brokerPort: 7443,
        dns: ['1.1.1.1'],
      },
    },
  } as const;

  expect(MovePlanSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#MovePlanSchema rejects a negative byte count', () => {
  const result = MovePlanSchema.safeParse({ bytes: -1, checkpoints: 2, warm: null });

  expect(result.error?.issues).toPartiallyContain({ path: ['bytes'], code: 'too_small' });
});

test('#MovePlanSchema rejects a fractional checkpoint count', () => {
  const result = MovePlanSchema.safeParse({ bytes: 4096, checkpoints: 1.5, warm: null });

  expect(result.error?.issues).toPartiallyContain({ path: ['checkpoints'], code: 'invalid_type' });
});

test('#MoveTicketSchema accepts a ticket', () => {
  const payload = {
    ticket: 'tk-1',
    expiresAt: new Date('2026-01-02T03:04:05.000Z'),
    peerUrl: 'https://100.64.0.2:7070',
  } as const;

  expect(MoveTicketSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#MoveTicketSchema rejects a peer URL that is not http or https', () => {
  const result = MoveTicketSchema.safeParse({
    ticket: 'tk-1',
    expiresAt: new Date('2026-01-02T03:04:05.000Z'),
    peerUrl: 'ftp://100.64.0.2',
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['peerUrl'], code: 'invalid_format' });
});

test('#MoveStatusSchema accepts a running move', () => {
  const payload = {
    state: 'sending',
    peer: 'host-b',
    sentBytes: 1024,
    totalBytes: 4096,
    isDone: false,
    error: null,
  } as const;

  expect(MoveStatusSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#MoveStatusSchema accepts no move', () => {
  const payload = {
    state: null,
    peer: null,
    sentBytes: 0,
    totalBytes: 0,
    isDone: false,
    error: null,
  } as const;

  expect(MoveStatusSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#MoveStatusSchema rejects a state outside the state list', () => {
  const result = MoveStatusSchema.safeParse({
    state: 'sent',
    peer: 'host-b',
    sentBytes: 1024,
    totalBytes: 4096,
    isDone: false,
    error: null,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['state'], code: 'invalid_value' });
});

test('#MoveStatusSchema rejects a negative sent byte count', () => {
  const result = MoveStatusSchema.safeParse({
    state: 'sending',
    peer: 'host-b',
    sentBytes: -1,
    totalBytes: 4096,
    isDone: false,
    error: null,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['sentBytes'], code: 'too_small' });
});

test('#MoveStatusSchema rejects a fractional total byte count', () => {
  const result = MoveStatusSchema.safeParse({
    state: 'sending',
    peer: 'host-b',
    sentBytes: 1024,
    totalBytes: 0.5,
    isDone: false,
    error: null,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['totalBytes'], code: 'invalid_type' });
});
