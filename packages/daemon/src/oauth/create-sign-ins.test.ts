import { expect, test } from 'bun:test';
import { invariant } from '@impz/test-utils/invariant';
import { ROOT_TOKEN_ID } from '../auth/token-store';
import { buildMockCaller } from '../test-utils/build-mock-caller';
import { createSignIns } from './create-sign-ins';

test('it starts a sign-in with an 8-symbol code that ends in 10 minutes', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'exec',
  });

  expect(started).toStrictEqual({
    kind: 'started',
    signIn: {
      key: 'client_id=impc_a&sig=s1',
      clientID: 'impc_a',
      clientName: 'conn',
      redirectURI: 'https://client.example/callback',
      requestedScope: 'exec',
      approvalCode: expect.toSatisfy((code: string) => /^[A-HJ-NP-Z2-9]{8}$/v.test(code)),
      createdAt: Date.UTC(2026, 0, 1),
      expiresAt: Date.UTC(2026, 0, 1) + 600_000,
      approval: null,
    },
  });
});

test('#find returns no sign-in once its 10 minutes ran out', () => {
  const clock = { nowMs: Date.UTC(2026, 0, 1) };
  const signIns = createSignIns({ now: () => clock.nowMs });

  signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  clock.nowMs += 600_000;

  expect(signIns.find('client_id=impc_a&sig=s1')).toBeNull();
});

test('#approve records the approver’s token, the scope and the imps', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'manage',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  const approver = buildMockCaller({ name: 'laptop', scope: 'exec', imps: ['dev-*'] });

  invariant(approver.tokenId);

  signIns.approve(started.signIn.approvalCode, approver, 'exec', ['dev-a']);

  expect(signIns.find('client_id=impc_a&sig=s1')?.approval).toStrictEqual({
    tokenID: approver.tokenId,
    tokenName: 'laptop',
    scope: 'exec',
    imps: ['dev-a'],
  });
});

test('#approve gives the approver’s own imps when it names none', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  signIns.approve(
    started.signIn.approvalCode,
    buildMockCaller({ imps: ['web-*'] }),
    'read',
    undefined,
  );

  expect(signIns.find('client_id=impc_a&sig=s1')?.approval?.imps).toStrictEqual(['web-*']);
});

test('#approve refuses the root token', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  expect(() =>
    signIns.approve(
      started.signIn.approvalCode,
      buildMockCaller({ tokenId: ROOT_TOKEN_ID }),
      'read',
      undefined,
    ),
  ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
});

test('#approve refuses a tailnet identity', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  expect(() =>
    signIns.approve(
      started.signIn.approvalCode,
      buildMockCaller({ kind: 'tailnet', tokenId: null }),
      'read',
      undefined,
    ),
  ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
});

test('#approve refuses a scope above the one the client asked for', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  expect(() =>
    signIns.approve(started.signIn.approvalCode, buildMockCaller(), 'exec', undefined),
  ).toThrow(expect.objectContaining({ code: 'BAD_REQUEST' }));
});

test('#approve refuses a scope above the approver’s own', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'manage',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  expect(() =>
    signIns.approve(
      started.signIn.approvalCode,
      buildMockCaller({ scope: 'read' }),
      'exec',
      undefined,
    ),
  ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
});

test('#approve refuses imps outside the approver’s own', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  expect(() =>
    signIns.approve(started.signIn.approvalCode, buildMockCaller({ imps: ['dev-*'] }), 'read', [
      'prod-db',
    ]),
  ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
});

test('#approve refuses a sign-in approved already', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  const approver = buildMockCaller();

  signIns.approve(started.signIn.approvalCode, approver, 'read', undefined);

  expect(() => signIns.approve(started.signIn.approvalCode, approver, 'read', undefined)).toThrow(
    expect.objectContaining({ code: 'CONFLICT' }),
  );
});

test('#approve refuses a code that matches no sign-in', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  expect(() => signIns.approve('ABCDEFGH', buildMockCaller(), 'read', undefined)).toThrow(
    expect.objectContaining({ code: 'NOT_FOUND' }),
  );
});

test('it drops a client’s oldest waiting sign-in for its fourth', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  for (const sig of ['s1', 's2', 's3', 's4']) {
    signIns.start({
      key: `client_id=impc_a&sig=${sig}`,
      clientID: 'impc_a',
      clientName: 'conn',
      redirectURI: 'https://client.example/callback',
      requestedScope: 'read',
    });
  }

  expect(signIns.find('client_id=impc_a&sig=s1')).toBeNull();
  expect(signIns.find('client_id=impc_a&sig=s4')).not.toBeNull();
});

test('it refuses a 17th waiting sign-in across clients', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  for (let client = 0; client < 16; client += 1) {
    signIns.start({
      key: `client_id=impc_${String(client)}&sig=s`,
      clientID: `impc_${String(client)}`,
      clientName: `conn-${String(client)}`,
      redirectURI: 'https://client.example/callback',
      requestedScope: 'read',
    });
  }

  const started = signIns.start({
    key: 'client_id=impc_late&sig=s',
    clientID: 'impc_late',
    clientName: 'late',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  expect(started).toStrictEqual({ kind: 'too-many', retryS: 600 });
});

test('#removeClient ends every waiting sign-in of the client', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  signIns.removeClient('impc_a');

  expect(signIns.find('client_id=impc_a&sig=s1')).toBeNull();
});

test('#removeClient never ends another client’s sign-in', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  signIns.start({
    key: 'client_id=impc_b&sig=s1',
    clientID: 'impc_b',
    clientName: 'other',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'read',
  });

  signIns.removeClient('impc_a');

  expect(signIns.find('client_id=impc_b&sig=s1')).not.toBeNull();
});

test('#readApproval shows the sign-in a code names', () => {
  const signIns = createSignIns({ now: () => Date.UTC(2026, 0, 1) });

  const started = signIns.start({
    key: 'client_id=impc_a&sig=s1',
    clientID: 'impc_a',
    clientName: 'conn',
    redirectURI: 'https://client.example/callback',
    requestedScope: 'exec',
  });

  if (started.kind !== 'started') {
    throw new Error('the sign-in did not start');
  }

  expect(signIns.readApproval(started.signIn.approvalCode, buildMockCaller())).toStrictEqual({
    client: 'conn',
    redirectUri: 'https://client.example/callback',
    requestedScope: 'exec',
    requestedAt: new Date(Date.UTC(2026, 0, 1)),
    expiresAt: new Date(Date.UTC(2026, 0, 1) + 600_000),
  });
});
