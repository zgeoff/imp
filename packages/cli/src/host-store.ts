import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { UsageError } from './usage-error';

export type CliEnv = Readonly<Record<string, string | undefined>>;

interface SavedHost {
  readonly url: string;
  readonly token: string | null;
}

export interface HostConfig {
  readonly current: string | null;
  readonly hosts: Readonly<Record<string, SavedHost>>;
}

const SavedHostSchema = z.object({ url: z.string(), token: z.string().nullable() });

const HostConfigSchema = z.object({
  current: z.string().nullable().default(null),
  hosts: z.record(z.string(), SavedHostSchema).default({}),
});

// A name a shell and a completion script take as one word, and never a URL,
// so `--host https://…` is caught as the mistake it is.
const HOST_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const EMPTY_CONFIG: HostConfig = { current: null, hosts: {} };

export function resolveConfigDir(env: CliEnv): string {
  const configHome = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');

  return join(configHome, 'imp');
}

export function resolveConfigPath(env: CliEnv): string {
  return join(resolveConfigDir(env), 'config.json');
}

export function checkHostName(name: string): string {
  if (!HOST_NAME.test(name)) {
    throw new UsageError(
      `not a host name: ${name} (letters, digits, '.', '_' and '-'; a URL goes to imp login)`,
    );
  }

  return name;
}

// The saved hosts, or none when there is no config file yet. A file that
// does not parse is an error, never an empty config: `imp login` would
// otherwise write over every host in it.
export function readHostConfig(env: CliEnv): HostConfig {
  const path = resolveConfigPath(env);
  let text: string;

  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return EMPTY_CONFIG;
    }

    throw error;
  }

  checkSharedMode(path);

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UsageError(`${path} is not valid JSON; fix or remove it`);
  }

  const result = HostConfigSchema.safeParse(parsed);

  if (!result.success) {
    throw new UsageError(`${path} is not an imp config (${z.prettifyError(result.error)})`);
  }

  return result.data;
}

// Writes a temp file with mode 0600 and renames it over the config, so a
// crash leaves the old file or the new one and no other user can read the
// tokens at any point.
export function writeHostConfig(env: CliEnv, config: HostConfig): void {
  const dir = resolveConfigDir(env);
  const path = resolveConfigPath(env);
  const temp = `${path}.${String(process.pid)}.tmp`;

  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // `wx` creates the file, so the mode applies; a temp file a crash left
  // behind could carry another mode, so it goes first
  rmSync(temp, { force: true });
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
}

// the file holds tokens: say so when someone else can read it, but leave the
// mode to its owner
function checkSharedMode(path: string): void {
  if ((statSync(path).mode & 0o077) !== 0) {
    console.error(`imp: warning: ${path} is readable by other users; run chmod 600 ${path}`);
  }
}
