import { expect, test } from 'bun:test';
import type { ImpState } from '@imp/api';
import type { StoredPublicAuth } from '../db/imps';
import { buildCredentialHash, createCredential, createPublicRoute } from './public-auth';
import { createPublicLimits } from './public-limits';

const CREDENTIAL = 'a:password:with:colons';
const BASIC = { auth: 'basic' as const, user: 'ann', hash: buildCredentialHash(CREDENTIAL) };

interface RouteOptions {
  readonly authorization?: string;
  readonly state?: ImpState;
  readonly limits?: ReturnType<typeof createPublicLimits>;
}

function resolveRoute(stored: StoredPublicAuth | undefined, options: RouteOptions = {}) {
  const found =
    stored === undefined ? undefined : { id: 'i1', state: options.state ?? 'running', stored };

  const route = createPublicRoute(
    () => Promise.resolve(found),
    options.limits ?? createPublicLimits(),
  );

  const authorization = options.authorization;

  return route(
    'web',
    new Request('https://web.imp.test/', {
      ...(authorization !== undefined && { headers: { authorization } }),
    }),
  );
}

function encodeBasic(text: string): string {
  return `Basic ${Buffer.from(text).toString('base64')}`;
}

test('a credential is 32 random bytes, and only its hash is kept', () => {
  const credential = createCredential();

  expect(credential).toMatch(/^[\w-]{43}$/);
  expect(createCredential()).not.toBe(credential);
  expect(buildCredentialHash(credential)).not.toContain(credential);
});

test('an imp that is not public has no route, whatever the request carries', async () => {
  const route = await resolveRoute(undefined, { authorization: 'Bearer anything' });

  expect(route).toBeNull();
});

test('basic auth splits at the first colon, so the password may hold more', async () => {
  const right = await resolveRoute(BASIC, { authorization: encodeBasic(`ann:${CREDENTIAL}`) });

  const lowercase = await resolveRoute(BASIC, {
    authorization: `basic ${Buffer.from(`ann:${CREDENTIAL}`).toString('base64')}`,
  });

  expect(right).toMatchObject({ kind: 'imp', name: 'web', public: { dropAuthorization: true } });
  expect(lowercase).toMatchObject({ kind: 'imp' });

  for (const header of [
    'Basic',
    'Basic !!!',
    encodeBasic('no colon'),
    encodeBasic(`bob:${CREDENTIAL}`),
    `Bearer ${CREDENTIAL}`,
  ]) {
    const route = await resolveRoute(BASIC, { authorization: header });

    expect({ header, kind: route?.kind }).toEqual({ header, kind: 'unauthorized' });
  }
});

test('a token imp takes only its bearer token, and a hash impd did not write lets nobody in', async () => {
  const token = createCredential();
  const stored = { auth: 'token' as const, user: null, hash: buildCredentialHash(token) };

  const right = await resolveRoute(stored, { authorization: `Bearer ${token}` });
  const wrong = await resolveRoute(stored, { authorization: `Bearer ${token}x` });

  const broken = await resolveRoute(
    { ...stored, hash: 'short' },
    { authorization: `Bearer ${token}` },
  );

  expect(right).toMatchObject({ kind: 'imp', public: { dropAuthorization: true } });

  expect(wrong).toEqual({
    kind: 'unauthorized',
    challenge: 'Bearer realm="web", charset="UTF-8"',
  });

  expect(broken?.kind).toBe('unauthorized');
});

test('an imp without auth passes the header on to the imp', async () => {
  const route = await resolveRoute(
    { auth: 'none', user: null, hash: null },
    { authorization: 'Bearer app-token' },
  );

  expect(route).toMatchObject({ kind: 'imp', public: { dropAuthorization: false } });
});

test('failed sign-ins turn into 429s, and the right credential still passes', async () => {
  const limits = createPublicLimits(() => 0);
  const kinds: (string | undefined)[] = [];

  for (let index = 0; index < 21; index += 1) {
    const route = await resolveRoute(BASIC, { limits, authorization: encodeBasic('ann:wrong') });

    kinds.push(route?.kind);
  }

  expect(kinds.slice(0, 20).every((kind) => kind === 'unauthorized')).toBe(true);
  expect(kinds[20]).toBe('limited');

  const right = await resolveRoute(BASIC, {
    limits,
    authorization: encodeBasic(`ann:${CREDENTIAL}`),
  });

  // no credential at all still gets the challenge, for the password prompt
  const bare = await resolveRoute(BASIC, { limits });

  expect(right?.kind).toBe('imp');
  expect(bare?.kind).toBe('unauthorized');
});

test('requests with no credential never use up the failure limit', async () => {
  const limits = createPublicLimits(() => 0);

  for (let index = 0; index < 50; index += 1) {
    await resolveRoute(BASIC, { limits });
  }

  const wrong = await resolveRoute(BASIC, { limits, authorization: encodeBasic('ann:wrong') });

  expect(wrong?.kind).toBe('unauthorized');
});

test('a sleeping imp wakes a limited number of times, and open requests are capped', async () => {
  const none = { auth: 'none' as const, user: null, hash: null };
  const clock = { ms: 0 };
  const limits = createPublicLimits(() => clock.ms);
  const releases: (() => void)[] = [];

  for (let index = 0; index < 10; index += 1) {
    const route = await resolveRoute(none, { limits, state: 'sleeping' });

    if (route?.kind === 'imp') {
      route.public?.release();
    }

    expect(route?.kind).toBe('imp');
  }

  const eleventh = await resolveRoute(none, { limits, state: 'sleeping' });

  expect(eleventh).toMatchObject({ kind: 'limited', retryAfterS: 6 });

  // a running imp needs no wake, and a token comes back with time
  const running = await resolveRoute(none, { limits });

  clock.ms += 6000;

  const later = await resolveRoute(none, { limits, state: 'sleeping' });

  expect([running?.kind, later?.kind]).toEqual(['imp', 'imp']);

  for (let index = 0; index < 62; index += 1) {
    const route = await resolveRoute(none, { limits });

    if (route?.kind === 'imp' && route.public !== undefined) {
      releases.push(route.public.release);
    }
  }

  // two held above, 62 here: the cap is 64
  const capped = await resolveRoute(none, { limits });

  expect(capped?.kind).toBe('limited');
  releases[0]?.();
  releases[0]?.();

  const freed = await resolveRoute(none, { limits });
  const full = await resolveRoute(none, { limits });

  expect([freed?.kind, full?.kind]).toEqual(['imp', 'limited']);
});
