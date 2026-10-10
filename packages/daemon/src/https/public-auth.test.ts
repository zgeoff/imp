import { expect, test } from 'bun:test';
import { buildMockStoredPublicAuth } from '../test-utils/build-mock-stored-public-auth';
import { buildCredentialHash, createCredential, createPublicRoute } from './public-auth';
import { createPublicLimits } from './public-limits';

test('#createCredential makes 32 random bytes as base64url', () => {
  expect(createCredential()).toMatch(/^[\w\-]{43}$/v);
});

test('#createCredential makes a different credential each time', () => {
  expect(createCredential()).not.toBe(createCredential());
});

test('#buildCredentialHash keeps the sha256 of the credential, not the credential', () => {
  // the sha256 of the credential in base64url, as `openssl dgst -sha256` gives it
  expect(buildCredentialHash('a:password:with:colons')).toBe(
    'Kxv9fUjDPFSK2V8fCksiazKmCViVet1wbpXvRf0AkUc',
  );
});

test('#createPublicRoute gives no route for an imp that is not public, whatever the request carries', async () => {
  const route = createPublicRoute(() => Promise.resolve(undefined), createPublicLimits());

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', { headers: { authorization: 'Bearer anything' } }),
  );

  expect(answer).toBeNull();
});

test('#createPublicRoute routes basic auth whose password holds colons, split at the first colon', async () => {
  const stored = buildMockStoredPublicAuth({
    user: 'ann',
    hash: buildCredentialHash('a:password:with:colons'),
  });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', {
      headers: {
        authorization: `Basic ${Buffer.from('ann:a:password:with:colons').toString('base64')}`,
      },
    }),
  );

  expect(answer).toStrictEqual({
    kind: 'imp',
    name: 'web',
    public: { dropAuthorization: true, release: expect.toBeFunction() },
  });
});

test('#createPublicRoute takes the basic scheme in lowercase', async () => {
  const stored = buildMockStoredPublicAuth({ user: 'ann', hash: buildCredentialHash('secret') });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', {
      headers: { authorization: `basic ${Buffer.from('ann:secret').toString('base64')}` },
    }),
  );

  expect(answer?.kind).toBe('imp');
});

test.each([
  ['Basic', 'a scheme with no value'],
  ['Basic !!!', 'a value that is not base64 of a user and password'],
  [`Basic ${Buffer.from('no colon').toString('base64')}`, 'a value with no colon'],
  [`Basic ${Buffer.from('bob:secret').toString('base64')}`, 'another user'],
  [`Basic ${Buffer.from('ann:wrong').toString('base64')}`, 'a wrong password'],
  ['Bearer secret', 'a bearer token'],
])('#createPublicRoute challenges basic auth given %s, %s', async (authorization) => {
  const stored = buildMockStoredPublicAuth({ user: 'ann', hash: buildCredentialHash('secret') });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', { headers: { authorization } }),
  );

  expect(answer).toStrictEqual({
    kind: 'unauthorized',
    challenge: 'Basic realm="web", charset="UTF-8"',
  });
});

test('#createPublicRoute challenges a basic auth imp when the request has no credential', async () => {
  const stored = buildMockStoredPublicAuth();

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(),
  );

  const answer = await route('web', new Request('https://web.imp.test/'));

  expect(answer).toStrictEqual({
    kind: 'unauthorized',
    challenge: 'Basic realm="web", charset="UTF-8"',
  });
});

test('#createPublicRoute routes a token imp given its bearer token', async () => {
  const stored = buildMockStoredPublicAuth({
    auth: 'token',
    user: null,
    hash: buildCredentialHash('app-token'),
  });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', { headers: { authorization: 'Bearer app-token' } }),
  );

  expect(answer).toStrictEqual({
    kind: 'imp',
    name: 'web',
    public: { dropAuthorization: true, release: expect.toBeFunction() },
  });
});

test('#createPublicRoute challenges a token imp given another token', async () => {
  const stored = buildMockStoredPublicAuth({
    auth: 'token',
    user: null,
    hash: buildCredentialHash('app-token'),
  });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', { headers: { authorization: 'Bearer app-tokenx' } }),
  );

  expect(answer).toStrictEqual({
    kind: 'unauthorized',
    challenge: 'Bearer realm="web", charset="UTF-8"',
  });
});

test('#createPublicRoute lets nobody in through a stored hash impd did not write', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'token', user: null, hash: 'short' });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', { headers: { authorization: 'Bearer short' } }),
  );

  expect(answer?.kind).toBe('unauthorized');
});

test('#createPublicRoute passes the authorization header on for an imp without auth', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'none', user: null, hash: null });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', { headers: { authorization: 'Bearer app-token' } }),
  );

  expect(answer).toStrictEqual({
    kind: 'imp',
    name: 'web',
    public: { dropAuthorization: false, release: expect.toBeFunction() },
  });
});

test('#createPublicRoute limits sign-ins after 20 failures', async () => {
  const stored = buildMockStoredPublicAuth({ user: 'ann', hash: buildCredentialHash('secret') });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(() => 0),
  );

  const wrong = `Basic ${Buffer.from('ann:wrong').toString('base64')}`;

  const failures = await Promise.all(
    Array.from({ length: 20 }, () =>
      route('web', new Request('https://web.imp.test/', { headers: { authorization: wrong } })),
    ),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', { headers: { authorization: wrong } }),
  );

  expect(failures).toSatisfyAll(
    (failure: Readonly<{ kind: string }> | null) => failure?.kind === 'unauthorized',
  );

  expect(answer).toStrictEqual({
    kind: 'limited',
    detail: 'Too many failed sign-ins; try again later.',
    retryAfterS: 3,
  });
});

test('#createPublicRoute routes the right credential after the failure limit is hit', async () => {
  const stored = buildMockStoredPublicAuth({ user: 'ann', hash: buildCredentialHash('secret') });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(() => 0),
  );

  const wrong = `Basic ${Buffer.from('ann:wrong').toString('base64')}`;

  await Promise.all(
    Array.from({ length: 21 }, () =>
      route('web', new Request('https://web.imp.test/', { headers: { authorization: wrong } })),
    ),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', {
      headers: { authorization: `Basic ${Buffer.from('ann:secret').toString('base64')}` },
    }),
  );

  expect(answer?.kind).toBe('imp');
});

test('#createPublicRoute still challenges a request with no credential after the failure limit is hit', async () => {
  const stored = buildMockStoredPublicAuth({ user: 'ann', hash: buildCredentialHash('secret') });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(() => 0),
  );

  const wrong = `Basic ${Buffer.from('ann:wrong').toString('base64')}`;

  await Promise.all(
    Array.from({ length: 21 }, () =>
      route('web', new Request('https://web.imp.test/', { headers: { authorization: wrong } })),
    ),
  );

  const answer = await route('web', new Request('https://web.imp.test/'));

  expect(answer?.kind).toBe('unauthorized');
});

test('#createPublicRoute counts no failure for requests with no credential', async () => {
  const stored = buildMockStoredPublicAuth({ user: 'ann', hash: buildCredentialHash('secret') });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(() => 0),
  );

  await Promise.all(
    Array.from({ length: 50 }, () => route('web', new Request('https://web.imp.test/'))),
  );

  const answer = await route(
    'web',
    new Request('https://web.imp.test/', {
      headers: { authorization: `Basic ${Buffer.from('ann:wrong').toString('base64')}` },
    }),
  );

  expect(answer?.kind).toBe('unauthorized');
});

test('#createPublicRoute wakes a sleeping imp 10 times in a burst', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'none', user: null, hash: null });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'sleeping', stored }),
    createPublicLimits(() => 0),
  );

  const answers = await Promise.all(
    Array.from({ length: 10 }, () => route('web', new Request('https://web.imp.test/'))),
  );

  expect(answers).toSatisfyAll(
    (answer: Readonly<{ kind: string }> | null) => answer?.kind === 'imp',
  );
});

test('#createPublicRoute limits the 11th wake of a sleeping imp in a burst', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'none', user: null, hash: null });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'sleeping', stored }),
    createPublicLimits(() => 0),
  );

  await Promise.all(
    Array.from({ length: 10 }, () => route('web', new Request('https://web.imp.test/'))),
  );

  const answer = await route('web', new Request('https://web.imp.test/'));

  expect(answer).toStrictEqual({
    kind: 'limited',
    detail: 'This site woke too often; try again later.',
    retryAfterS: 6,
  });
});

test('#createPublicRoute routes a running imp once the wake limit is hit', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'none', user: null, hash: null });
  const imp = { id: 'i1', state: 'sleeping' as const, stored };
  const limits = createPublicLimits(() => 0);
  const sleeping = createPublicRoute(() => Promise.resolve(imp), limits);
  const running = createPublicRoute(() => Promise.resolve({ ...imp, state: 'running' }), limits);

  await Promise.all(
    Array.from({ length: 11 }, () => sleeping('web', new Request('https://web.imp.test/'))),
  );

  const answer = await running('web', new Request('https://web.imp.test/'));

  expect(answer?.kind).toBe('imp');
});

test('#createPublicRoute wakes a sleeping imp again 6 seconds after the wake limit is hit', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'none', user: null, hash: null });
  const clock = { ms: 0 };

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'sleeping', stored }),
    createPublicLimits(() => clock.ms),
  );

  await Promise.all(
    Array.from({ length: 11 }, () => route('web', new Request('https://web.imp.test/'))),
  );

  clock.ms = 6000;

  const answer = await route('web', new Request('https://web.imp.test/'));

  expect(answer?.kind).toBe('imp');
});

test('#createPublicRoute limits the 65th open request to one imp', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'none', user: null, hash: null });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(() => 0),
  );

  await Promise.all(
    Array.from({ length: 64 }, () => route('web', new Request('https://web.imp.test/'))),
  );

  const answer = await route('web', new Request('https://web.imp.test/'));

  expect(answer).toStrictEqual({
    kind: 'limited',
    detail: 'Too many open requests to this site.',
    retryAfterS: 1,
  });
});

test('#createPublicRoute frees one open slot for a release, however often it runs', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'none', user: null, hash: null });

  const route = createPublicRoute(
    () => Promise.resolve({ id: 'i1', state: 'running', stored }),
    createPublicLimits(() => 0),
  );

  const held = await Promise.all(
    Array.from({ length: 64 }, () => route('web', new Request('https://web.imp.test/'))),
  );

  const [first] = held;

  if (first?.kind !== 'imp' || first.public === undefined) {
    throw new Error('the first request was not routed to the imp');
  }

  first.public.release();
  first.public.release();

  const answers = await Promise.all(
    Array.from({ length: 2 }, () => route('web', new Request('https://web.imp.test/'))),
  );

  expect(answers.map((answer) => answer?.kind)).toStrictEqual(['imp', 'limited']);
});

test('#createPublicRoute gives back the open slot of a wake it limits', async () => {
  const stored = buildMockStoredPublicAuth({ auth: 'none', user: null, hash: null });
  const imp = { id: 'i1', state: 'sleeping' as const, stored };
  const limits = createPublicLimits(() => 0);
  const sleeping = createPublicRoute(() => Promise.resolve(imp), limits);
  const running = createPublicRoute(() => Promise.resolve({ ...imp, state: 'running' }), limits);

  await Promise.all(
    Array.from({ length: 10 }, () => sleeping('web', new Request('https://web.imp.test/'))),
  );

  // the ten wakes above stay open, so 53 more leave one slot below the cap of 64
  await Promise.all(
    Array.from({ length: 53 }, () => running('web', new Request('https://web.imp.test/'))),
  );

  await sleeping('web', new Request('https://web.imp.test/'));

  const answer = await running('web', new Request('https://web.imp.test/'));

  expect(answer?.kind).toBe('imp');
});
