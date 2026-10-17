import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkHostName, readHostConfig, resolveConfigDir } from './host-store';
import type { CliEnv } from './host-store';
import { updateLegacyConfig } from './update-legacy-config';
import { UsageError } from './usage-error';

export interface CliConfig {
  readonly url: string;
  readonly token: string | null;

  // the saved host the URL and token came from, or null for IMP_URL and the
  // local default
  readonly host: string | null;
}

const DEFAULT_URL = 'http://localhost:7070';

// The impd to call and its token, always from one source, so a token never
// goes to an impd it was not saved for; `warn` gets the notes for stderr.
// The order is in docs/guides/configuration.md#cli.
export function loadCliConfig(
  env: CliEnv,
  host: string | null,
  warn: (line: string) => void = console.error,
): CliConfig {
  const envToken = readVariable(env, 'IMP_TOKEN');
  const named = host === null ? readHostVariable(env) : checkHostName(host);

  if (named !== null) {
    if (envToken !== null) {
      warn(`impz: note: IMP_TOKEN is ignored; ${named} uses its saved token`);
    }

    return loadSavedHost(env, named, warn);
  }

  const envUrl = readVariable(env, 'IMP_URL');

  if (envUrl !== null) {
    if (!isHttpUrl(envUrl)) {
      throw new UsageError(`IMP_URL is not an http(s) URL: ${envUrl}`);
    }

    return { url: envUrl, token: envToken, host: null };
  }

  const config = readHostConfig(env, warn);

  if (config.current !== null) {
    const saved = loadSavedHost(env, config.current, warn);

    return { ...saved, token: envToken ?? saved.token };
  }

  return { url: DEFAULT_URL, token: envToken ?? readTokenFile(env, warn), host: null };
}

export function isHttpUrl(url: string): boolean {
  return /^https?:$/u.test(URL.parse(url)?.protocol ?? '');
}

function loadSavedHost(env: CliEnv, name: string, warn: (line: string) => void): CliConfig {
  const saved = readHostConfig(env, warn).hosts[name];

  if (saved === undefined) {
    throw new UsageError(
      `no saved host ${name} (see impz host ls, or impz login <url> --name ${name})`,
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

function readTokenFile(env: CliEnv, warn: (line: string) => void): string | null {
  const dir = resolveConfigDir(env);

  updateLegacyConfig(dir, warn);

  const path = join(dir, 'token');

  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
}

function readVariable(env: CliEnv, name: string): string | null {
  const value = env[name];

  return value === undefined || value === '' ? null : value;
}
