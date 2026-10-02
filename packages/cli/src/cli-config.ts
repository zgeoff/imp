import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkHostName, readHostConfig, resolveConfigDir } from './host-store';
import type { CliEnv } from './host-store';
import { UsageError } from './usage-error';

export interface CliConfig {
  readonly url: string;
  readonly token: string | null;

  // the saved host the URL and token came from, or null for IMP_URL and the
  // local default
  readonly host: string | null;
}

const DEFAULT_URL = 'http://localhost:7070';

// what `--host` named, set once by main before any command runs
let selectedHost: string | null = null;

export function setSelectedHost(name: string): void {
  selectedHost = checkHostName(name);
}

// The impd to call and its token, always from one source, so a token never
// goes to an impd it was not saved for. The order is in
// docs/guides/configuration.md#cli; the tests cover every combination.
export function loadCliConfig(env: CliEnv, host: string | null = selectedHost): CliConfig {
  const envToken = readVariable(env, 'IMP_TOKEN');
  const named = host ?? readHostVariable(env);

  if (named !== null) {
    return loadSavedHost(env, named);
  }

  const envUrl = readVariable(env, 'IMP_URL');

  if (envUrl !== null) {
    if (!isHttpUrl(envUrl)) {
      throw new UsageError(`IMP_URL is not an http(s) URL: ${envUrl}`);
    }

    return { url: envUrl, token: envToken, host: null };
  }

  const config = readHostConfig(env);

  if (config.current !== null) {
    const saved = loadSavedHost(env, config.current);

    return { ...saved, token: envToken ?? saved.token };
  }

  return { url: DEFAULT_URL, token: envToken ?? readTokenFile(env), host: null };
}

export function isHttpUrl(url: string): boolean {
  return /^https?:$/.test(URL.parse(url)?.protocol ?? '');
}

function loadSavedHost(env: CliEnv, name: string): CliConfig {
  const saved = readHostConfig(env).hosts[name];

  if (saved === undefined) {
    throw new UsageError(
      `no saved host ${name} (see imp host ls, or imp login <url> --name ${name})`,
    );
  }

  return { url: saved.url, token: saved.token, host: name };
}

function readHostVariable(env: CliEnv): string | null {
  const name = readVariable(env, 'IMP_HOST');

  if (name?.includes('://') === true) {
    throw new UsageError('IMP_HOST names a saved host; use IMP_URL');
  }

  return name === null ? null : checkHostName(name);
}

function readTokenFile(env: CliEnv): string | null {
  const path = join(resolveConfigDir(env), 'token');

  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
}

function readVariable(env: CliEnv, name: string): string | null {
  const value = env[name];

  return value === undefined || value === '' ? null : value;
}
