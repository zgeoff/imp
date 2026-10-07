import type { OAuthConfig } from '@imp/api';
import * as z from 'zod';
import type { ImpDatabase } from '../db/open-database';
import { findSecret, listSecrets } from '../db/secrets';
import type { SecretRecord } from '../db/secrets';
import { readErrorMessage } from '../read-error-message';
import type { Upstream } from './forward-request';
import { formatOAuthState, isHeaderSafeToken, parseOAuthState, readJwtExpiry } from './oauth-state';
import type { OAuthStateFile } from './oauth-state';
import type { SecretFiles } from './secret-files';

// Keeps each oauth secret's access token fresh (docs/guides/connectors.md
// #oauth-secrets). It never logs or returns a token: a log line says only
// whether the refresh token rotated and when the access token expires.

export interface OAuthRequest {
  readonly method: 'POST';
  readonly headers: Headers;
  readonly body: string;
  readonly redirect: 'manual';
  readonly signal: AbortSignal;
  readonly tls?: { readonly ca: readonly string[] };
}

export type OAuthFetch = (url: string, init: OAuthRequest) => Promise<Response>;

type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly rotated: boolean }
  | { readonly kind: 'transient'; readonly error: string }
  | { readonly kind: 'needs-login'; readonly error: string }

  // replaced or deleted during the call; the result was dropped
  | { readonly kind: 'dropped' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' };

interface OAuthRefresher {
  // Refreshes now and answers after it ends. A refresh already running for
  // the secret is the one answered; there is never a second request.
  // `force` skips the backoff and the needs_login stop.
  readonly refresh: (name: string, force: boolean) => Promise<RefreshOutcome>;

  // runs `work` after every earlier lock holder of the secret has ended
  readonly withLock: <T>(name: string, work: () => Promise<T>) => Promise<T>;

  // refreshes each secret that is due; never rejects
  readonly tick: () => Promise<void>;

  // the timer, and one tick at once
  readonly start: () => void;
  readonly stop: () => Promise<void>;
}

interface OAuthRefresherDeps {
  readonly db: ImpDatabase;
  readonly files: Pick<SecretFiles, 'read' | 'rewrite'>;
  readonly log: (message: string) => void;
  readonly resolveUpstream: (host: string) => Upstream;
  readonly fetch?: OAuthFetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly tickMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const MAX_LEAD_MS = 24 * HOUR_MS;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

// error codes that mean the refresh token is dead
const PERMANENT_CODES = new Set([
  'invalid_grant',
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
]);

interface TokenResponse {
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly idToken: string | null;
  readonly expiresInMs: number | null;
}

type Classified =
  | { readonly kind: 'ok'; readonly tokens: TokenResponse }
  | { readonly kind: 'transient'; readonly error: string }
  | { readonly kind: 'permanent'; readonly error: string };

export function createOAuthRefresher(deps: OAuthRefresherDeps): OAuthRefresher {
  const now = deps.now ?? Date.now;
  const send = deps.fetch ?? sendToken;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const log = deps.log;

  const tails = new Map<string, Promise<void>>();
  const inflight = new Map<string, Promise<RefreshOutcome>>();
  const backoff = new Map<string, { failures: number; nextAt: number }>();

  // a result whose write failed, kept to write again before the next call:
  // the refresh token it holds may be the only live one
  const unsaved = new Map<string, { valueFile: string; state: OAuthStateFile }>();

  const lifecycle = { stopping: false };

  const timer: { handle: ReturnType<typeof setInterval> | null; running: Promise<void> | null } = {
    handle: null,
    running: null,
  };

  // Each holder waits for the one before it; a gate opens when its work ends,
  // however it ends, so the chain never rejects.
  const withLock = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(name) ?? Promise.resolve();
    const gate = Promise.withResolvers<void>();

    tails.set(name, gate.promise);

    await previous;

    try {
      return await work();
    } finally {
      gate.resolve();

      if (tails.get(name) === gate.promise) {
        tails.delete(name);
      }
    }
  };

  const writeState = (
    name: string,
    valueFile: string,
    state: Readonly<OAuthStateFile>,
  ): boolean => {
    try {
      deps.files.rewrite(valueFile, formatOAuthState(state));
      unsaved.delete(name);

      return true;
    } catch (error) {
      unsaved.set(name, { valueFile, state });

      log(
        `impd: broker: oauth secret ${name}: could not write its value file: ${readErrorMessage(error)}`,
      );

      return false;
    }
  };

  // the state to start from: a result not yet written, else the file
  const loadState = (name: string, secret: Readonly<SecretRecord>): OAuthStateFile | null => {
    const kept = unsaved.get(name);

    if (kept?.valueFile === secret.valueFile) {
      return kept.state;
    }

    const text = deps.files.read(secret.valueFile);

    return text === null ? null : parseOAuthState(text);
  };

  const sendTokenRequest = async (
    config: Readonly<OAuthConfig>,
    refreshToken: string,
  ): Promise<Classified> => {
    const url = new URL(config.tokenUrl);

    const upstream = deps.resolveUpstream(url.host);

    const fields = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    };

    const headers = new Headers({ accept: 'application/json' });

    let body: string;

    if (config.tokenFormat === 'json') {
      headers.set('content-type', 'application/json');

      body = JSON.stringify(fields);
    } else {
      headers.set('content-type', 'application/x-www-form-urlencoded');

      body = new URLSearchParams(fields).toString();
    }

    let response: Response;
    let text: string;

    // the whole call, the body included, is under the timeout
    try {
      response = await send(`${upstream.origin}${url.pathname}${url.search}`, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(upstream.ca !== null && { tls: { ca: upstream.ca } }),
      });

      text = await response.text();
    } catch (error) {
      return {
        kind: 'transient',
        error:
          error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network error',
      };
    }

    return parseAnswer(response.status, text);
  };

  const runRefresh = async (name: string, force: boolean): Promise<RefreshOutcome> => {
    const secret = await findSecret(deps.db, name);

    if (secret?.kind !== 'oauth' || secret.oauth === null) {
      unsaved.delete(name);
      backoff.delete(name);

      return { kind: 'gone' };
    }

    const state = loadState(name, secret);

    if (state === null) {
      log(`impd: broker: oauth secret ${name}: its value file is missing or unreadable`);

      return { kind: 'unreadable' };
    }

    // a result an earlier write failed on goes first
    if (unsaved.has(name) && !writeState(name, secret.valueFile, state)) {
      return { kind: 'transient', error: 'value file not writable' };
    }

    if (!force && state.status === 'needs_login') {
      return { kind: 'needs-login', error: state.error ?? 'needs login' };
    }

    const classified = await sendTokenRequest(secret.oauth, state.refreshToken);

    // a replace or a delete outside the lock changed what this result is for
    const current = await findSecret(deps.db, name);

    if (current?.valueFile !== secret.valueFile || current.generation !== secret.generation) {
      log(
        `impd: broker: oauth secret ${name} was replaced or deleted during a refresh; its result was dropped`,
      );

      return { kind: 'dropped' };
    }

    if (classified.kind === 'ok') {
      return applyTokens(name, secret, state, classified.tokens);
    }

    return applyFailure(name, secret, state, classified);
  };

  const applyTokens = (
    name: string,
    secret: Readonly<SecretRecord>,
    state: Readonly<OAuthStateFile>,
    tokens: Readonly<TokenResponse>,
  ): RefreshOutcome => {
    const at = now();
    const accessToken = tokens.accessToken ?? state.accessToken;

    if (accessToken === null) {
      // a rotated refresh token is the only live one: keep it
      const kept =
        tokens.refreshToken === null ? state : { ...state, refreshToken: tokens.refreshToken };

      return writeTransient(name, secret, kept, 'no access token in the response');
    }

    const refreshToken = tokens.refreshToken ?? state.refreshToken;

    // a response with only a rotated refresh token leaves the access token
    // and its expiry as they were
    let expiresAt: number | null;

    if (tokens.expiresInMs !== null) {
      expiresAt = at + tokens.expiresInMs;
    } else if (tokens.accessToken === null) {
      expiresAt = state.expiresAt;
    } else {
      expiresAt = readJwtExpiry(accessToken);
    }

    // an expiry no date can hold is no expiry; the tokens are kept all the same
    if (expiresAt !== null && !isValidTime(expiresAt)) {
      expiresAt = null;
    }

    const next: OAuthStateFile = {
      v: 1,
      refreshToken,
      accessToken,
      idToken: tokens.idToken ?? state.idToken,
      expiresAt,
      refreshedAt: at,
      status: 'ready',
      error: null,
    };

    backoff.delete(name);

    // The old value is not live once the endpoint rotated it, so a failed
    // write keeps this result in memory for the next try (see `unsaved`)
    writeState(name, secret.valueFile, next);

    const rotated = refreshToken !== state.refreshToken;

    log(
      `impd: broker: oauth secret ${name} refreshed; refresh token rotated: ${rotated ? 'yes' : 'no'}; expires ${expiresAt === null ? 'never known' : new Date(expiresAt).toISOString()}`,
    );

    return { kind: 'refreshed', rotated };
  };

  const writeTransient = (
    name: string,
    secret: Readonly<SecretRecord>,
    state: Readonly<OAuthStateFile>,
    error: string,
  ): RefreshOutcome => {
    const failures = (backoff.get(name)?.failures ?? 0) + 1;
    const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));

    backoff.set(name, { failures, nextAt: now() + delay });

    writeState(name, secret.valueFile, { ...state, error });

    log(
      `impd: broker: oauth secret ${name} could not refresh: ${error}; trying again in ${String(Math.round(delay / 60_000))} min`,
    );

    return { kind: 'transient', error };
  };

  const applyFailure = (
    name: string,
    secret: Readonly<SecretRecord>,
    state: Readonly<OAuthStateFile>,
    failure: Exclude<Classified, { kind: 'ok' }>,
  ): RefreshOutcome => {
    if (failure.kind === 'transient') {
      return writeTransient(name, secret, state, failure.error);
    }

    backoff.delete(name);

    // the refresh token is dead but harmless, so the file stays as it is
    writeState(name, secret.valueFile, { ...state, status: 'needs_login', error: failure.error });

    if (state.status !== 'needs_login') {
      log(`impd: broker: oauth secret ${name} needs a new sign-in: ${failure.error}`);
    }

    return { kind: 'needs-login', error: failure.error };
  };

  const startRefresh = (name: string, force: boolean): Promise<RefreshOutcome> => {
    if (lifecycle.stopping) {
      return Promise.resolve({ kind: 'transient', error: 'impd is stopping' });
    }

    const running = inflight.get(name);

    if (running !== undefined) {
      return running;
    }

    const started = (async () => {
      try {
        return await withLock(name, () => runRefresh(name, force));
      } finally {
        inflight.delete(name);
      }
    })();

    inflight.set(name, started);

    return started;
  };

  // Writes a result an earlier write failed on. The secret's row is read
  // again under the lock: a result for a secret since deleted or replaced is
  // dropped, never written.
  const writeUnsaved = async (name: string): Promise<void> => {
    if (!unsaved.has(name)) {
      return;
    }

    try {
      await withLock(name, async () => {
        const kept = unsaved.get(name);

        if (kept === undefined) {
          return;
        }

        const current = await findSecret(deps.db, name);

        if (current?.kind !== 'oauth' || current.valueFile !== kept.valueFile) {
          unsaved.delete(name);

          return;
        }

        writeState(name, kept.valueFile, kept.state);
      });
    } catch (error) {
      log(`impd: broker: oauth secret ${name}: ${readErrorMessage(error)}`);
    }
  };

  const runDueRefreshes = async (): Promise<void> => {
    try {
      const at = now();

      const listed = await listSecrets(deps.db);

      for (const entry of listed) {
        const secret = entry.secret;

        if (lifecycle.stopping) {
          break;
        }

        if (secret.kind !== 'oauth' || secret.oauth === null) {
          continue;
        }

        // a result whose write failed is written again at every tick,
        // whether or not the secret is due
        await writeUnsaved(secret.name);

        const wait = backoff.get(secret.name);

        if (wait !== undefined && wait.nextAt > at) {
          continue;
        }

        const state = loadState(secret.name, secret);

        if (state === null || !isDue(state, at)) {
          continue;
        }

        try {
          await startRefresh(secret.name, false);
        } catch (error) {
          log(`impd: broker: oauth secret ${secret.name}: ${readErrorMessage(error)}`);
        }
      }
    } catch (error) {
      log(`impd: broker: oauth refresh check failed: ${readErrorMessage(error)}`);
    }
  };

  const startDueRun = (): void => {
    if (timer.running !== null) {
      return;
    }

    timer.running = (async () => {
      try {
        await runDueRefreshes();
      } finally {
        timer.running = null;
      }
    })();
  };

  return {
    refresh: startRefresh,
    withLock,
    tick: runDueRefreshes,
    start: () => {
      startDueRun();

      timer.handle = setInterval(startDueRun, deps.tickMs ?? 60_000);

      timer.handle.unref();
    },
    stop: async () => {
      lifecycle.stopping = true;

      if (timer.handle !== null) {
        clearInterval(timer.handle);

        timer.handle = null;
      }

      await timer.running;

      // a refresh under way ends, its write included, before stop answers
      await Promise.allSettled(inflight.values());

      // one last try at each result still unsaved, for a restart to find
      await Promise.allSettled([...unsaved.keys()].map((name) => writeUnsaved(name)));
    },
  };
}

// Whether a refresh is due: now when there is no access token; else once
// less than min(24 h, half the lifetime) is left, so an impd stopped for a
// day never hands out an expired token. A needs_login secret never is.
export function isDue(state: Readonly<OAuthStateFile>, at: number): boolean {
  if (state.status === 'needs_login') {
    return false;
  }

  if (state.status === 'pending' || state.accessToken === null) {
    return true;
  }

  if (state.expiresAt === null) {
    return state.refreshedAt === null || at - state.refreshedAt > HOUR_MS;
  }

  const remaining = state.expiresAt - at;

  if (state.refreshedAt === null) {
    return remaining <= 0;
  }

  const lifetime = state.expiresAt - state.refreshedAt;

  return remaining < Math.min(MAX_LEAD_MS, lifetime / 2);
}

// the error of a token endpoint's answer: a string, or an object with a
// `code` or an `error` string
const ErrorObjectSchema = z.object({ code: z.string().nullish(), error: z.string().nullish() });
const ErrorAnswerSchema = z.object({ error: z.union([z.string(), ErrorObjectSchema]) });

const TokenAnswerSchema = z.object({
  access_token: z.string().nullish(),
  refresh_token: z.string().nullish(),
  id_token: z.string().nullish(),
  expires_in: z.number().nullish(),
});

// a code a log line and an API answer may carry: short and plain
function readErrorCode(body: unknown): string | null {
  const parsed = ErrorAnswerSchema.safeParse(body);

  if (!parsed.success) {
    return null;
  }

  const error = parsed.data.error;
  const code = typeof error === 'string' ? error : (error.code ?? error.error);

  return code !== null && code !== undefined && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null;
}

function parseAnswer(status: number, text: string): Classified {
  let body: unknown = null;

  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  const code = readErrorCode(body);

  if (code !== null && PERMANENT_CODES.has(code)) {
    return { kind: 'permanent', error: code };
  }

  if (status === 401) {
    return { kind: 'permanent', error: code ?? 'HTTP 401' };
  }

  if (status < 200 || status >= 300) {
    return { kind: 'transient', error: `HTTP ${String(status)}` };
  }

  return readTokens(body);
}

function readTokens(body: unknown): Classified {
  const parsed = TokenAnswerSchema.safeParse(body);

  if (!parsed.success) {
    return { kind: 'transient', error: 'invalid response' };
  }

  const accessToken = parsed.data.access_token ?? null;
  const refreshToken = parsed.data.refresh_token ?? null;
  const idToken = parsed.data.id_token ?? null;

  // a token goes into a header or a file: one that could split a header is
  // not one
  const unusable = [accessToken, refreshToken, idToken].some(
    (token) => token !== null && !isHeaderSafeToken(token),
  );

  if (unusable) {
    return { kind: 'transient', error: 'invalid response' };
  }

  // a 200 that carries no token refreshed nothing
  if (accessToken === null && refreshToken === null) {
    return { kind: 'transient', error: 'no token in the response' };
  }

  // 0 or less is a token that is already due, not an unknown expiry
  const expiresIn = parsed.data.expires_in ?? null;
  const expiresInMs = expiresIn === null ? null : Math.max(0, expiresIn) * 1000;

  return { kind: 'ok', tokens: { accessToken, refreshToken, idToken, expiresInMs } };
}

// a time in ms that a Date can hold
function isValidTime(ms: number): boolean {
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime());
}

function sendToken(url: string, init: OAuthRequest): Promise<Response> {
  const tls = init.tls === undefined ? {} : { tls: { ca: [...init.tls.ca] } };

  return fetch(url, { ...init, ...tls });
}
