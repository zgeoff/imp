import { expect, test } from 'bun:test';
import { buildMockMoveSendRow } from './build-mock-move-send-row';

test('it builds a default move send row', () => {
  expect(buildMockMoveSendRow()).toStrictEqual({
    imp_id: expect.toBeString(),
    peer_url: null,
    ticket: null,
    total_bytes: expect.toBeWithin(1, 64 * 1024 ** 3 + 1),
    mode: 'files',
    warm: 0,
    receipt: null,
    error: null,
    created_at: expect.toBeNumber(),
  });
});

test('it applies overrides on top of the defaults', () => {
  const row = buildMockMoveSendRow({
    imp_id: 'imp-1',
    peer_url: 'https://target.test:7071',
    ticket: 'ticket',
    total_bytes: 1,
    mode: 'zfs',
    warm: 1,
    receipt: '{}',
    error: 'the target did not answer',
    created_at: 0,
  });

  expect(row).toStrictEqual({
    imp_id: 'imp-1',
    peer_url: 'https://target.test:7071',
    ticket: 'ticket',
    total_bytes: 1,
    mode: 'zfs',
    warm: 1,
    receipt: '{}',
    error: 'the target did not answer',
    created_at: 0,
  });
});
