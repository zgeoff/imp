import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig {
  readonly url: string;
  readonly token: string | null;
}

const DEFAULT_URL = 'http://localhost:7070';

// IMP_TOKEN wins over the token file, so a one-off call can target another
// impd without touching ~/.config/imp/token. An empty variable counts as
// unset, as `IMP_URL= imp ls` means.
export function loadCliConfig(env: Readonly<Record<string, string | undefined>>): CliConfig {
  const envUrl = env['IMP_URL'];
  const url = envUrl === undefined || envUrl === '' ? DEFAULT_URL : envUrl;
  const configHome = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  const tokenPath = join(configHome, 'imp', 'token');
  const envToken = env['IMP_TOKEN'];

  if (envToken !== undefined && envToken !== '') {
    return { url, token: envToken };
  }

  if (existsSync(tokenPath)) {
    return { url, token: readFileSync(tokenPath, 'utf8').trim() };
  }

  return { url, token: null };
}
