import type { CliEnv } from '../config/host-store';

// the terminal type a remote shell takes from this one
export function readTermEnv(env: CliEnv): Record<string, string> {
  return { TERM: env['TERM'] ?? 'xterm-256color' };
}
