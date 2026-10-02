import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PublicImp } from '../db/exposure';
import type { StoredPublicAuth } from '../db/imps';
import type { ProxyRoute } from '../proxy/wake-proxy';
import type { ListenerScope } from './https-listeners';
import type { PublicLimits } from './public-limits';

// A public imp's token or password: impd makes it, so it is long enough
// that a fast hash is safe to store and to check on every request.
export function createCredential(): string {
  return randomBytes(32).toString('base64url');
}

export function buildCredentialHash(credential: string): string {
  return createHash('sha256').update(credential).digest('base64url');
}

// What the public listeners serve (ListenerScope): the route, and the
// redirect's check, which has no side effects
export function createPublicScope(
  findPublicImp: (name: string) => Promise<PublicImp | undefined>,
  limits: PublicLimits,
): ListenerScope {
  return {
    kind: 'public',
    routeImp: createPublicRoute(findPublicImp, limits),
    isPublic: async (name) => {
      const found = await findPublicImp(name);

      return found !== undefined;
    },
  };
}

// The public listeners' route for an imp name: null while the imp is not
// public, whatever the request carries. The credential and the limits are
// checked before the wake, so a stranger never boots the imp.
export function createPublicRoute(
  findPublicImp: (name: string) => Promise<PublicImp | undefined>,
  limits: PublicLimits,
): (name: string, request: Request) => Promise<ProxyRoute | null> {
  return async (name, request) => {
    const found = await findPublicImp(name);

    if (found === undefined) {
      return null;
    }

    const stored = found.stored;
    const authorization = request.headers.get('authorization');
    const scheme = stored.auth === 'token' ? 'Bearer' : 'Basic';
    const challenge = `${scheme} realm="${name}", charset="UTF-8"`;

    // No credential at all is a browser before its password prompt: it
    // always gets the challenge, and counts against no limit, so a stranger
    // cannot block the prompt.
    if (stored.auth !== 'none' && authorization === null) {
      return { kind: 'unauthorized', challenge };
    }

    if (!checkCredential(stored, authorization)) {
      // a correct credential always passes, so the limit locks out guesses only
      if (!limits.tryFail(found.id)) {
        return buildLimited(
          'Too many failed sign-ins; try again later.',
          limits.readRetryS('failure'),
        );
      }

      return { kind: 'unauthorized', challenge };
    }

    const release = limits.tryOpen(found.id);

    if (release === null) {
      return buildLimited('Too many open requests to this site.', 1);
    }

    if (found.state !== 'running' && !limits.tryWake(found.id)) {
      release();

      return buildLimited('This site woke too often; try again later.', limits.readRetryS('wake'));
    }

    return {
      kind: 'imp',
      name,
      public: { dropAuthorization: stored.auth !== 'none', release },
    };
  };
}

function buildLimited(detail: string, retryAfterS: number): ProxyRoute {
  return { kind: 'limited', detail, retryAfterS };
}

// true for no auth, or the right token, or basic's user and password
function checkCredential(stored: StoredPublicAuth, authorization: string | null): boolean {
  if (stored.auth === 'none') {
    return true;
  }

  const presented = readPresented(stored, authorization);

  if (presented === null || stored.hash === null) {
    return false;
  }

  const storedDigest = Buffer.from(stored.hash, 'base64url');
  const presentedDigest = buildDigest(presented.secret);

  // a stored hash impd did not write lets nobody in
  if (storedDigest.length !== presentedDigest.length) {
    return false;
  }

  // both sides as sha256 digests: equal lengths, compared in constant time
  const isUser = stored.auth !== 'basic' || isSameDigest(presented.user ?? '', stored.user ?? '');
  const isSecret = timingSafeEqual(presentedDigest, storedDigest);

  return isUser && isSecret;
}

interface Presented {
  readonly user: string | null;
  readonly secret: string;
}

// the token, or basic auth's user and password, as the header carries them
function readPresented(stored: StoredPublicAuth, authorization: string | null): Presented | null {
  const match = /^(?<scheme>\S+) +(?<value>\S+)$/.exec(authorization?.trim() ?? '')?.groups;
  const scheme = match?.['scheme']?.toLowerCase();
  const value = match?.['value'];

  if (value === undefined) {
    return null;
  }

  if (stored.auth === 'token') {
    return scheme === 'bearer' ? { user: null, secret: value } : null;
  }

  if (scheme !== 'basic') {
    return null;
  }

  const decoded = Buffer.from(value, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');

  return colon === -1 ? null : { user: decoded.slice(0, colon), secret: decoded.slice(colon + 1) };
}

function buildDigest(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

function isSameDigest(a: string, b: string): boolean {
  return timingSafeEqual(buildDigest(a), buildDigest(b));
}
