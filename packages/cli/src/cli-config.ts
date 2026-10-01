import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CliConfig {
  readonly url: string;
  readonly token: string | null;
}

// IMP_TOKEN wins over the token file, so a one-off call can target another
// impd without touching ~/.config/imp/token.
export function loadCliConfig(env: Readonly<Record<string, string | undefined>>): CliConfig {
  const url = env['IMP_URL'] ?? 'http://localhost:7070';
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
