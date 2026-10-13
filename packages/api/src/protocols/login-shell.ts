// The login shell of the user an exec runs as, from the image's /etc/passwd,
// else bash, else sh. Plain sh: the image may have neither awk nor getent.
// `imp console` and the SSH gateway run it as `/bin/sh -c CONSOLE_SHELL`.
export const CONSOLE_SHELL = buildConsoleShell('/etc/passwd', ['/bin/bash', '/bin/sh']);

// The same script over another passwd file and other fallback shells, so a
// test can run it without the host's users and shells; paths hold no quote.
export function buildConsoleShell(passwdPath: string, fallbacks: readonly string[]): string {
  return [
    'uid=$(id -u 2>/dev/null) || uid=0',
    'shell=',
    'while IFS=: read -r _ _ id _ _ _ login; do',
    '  if [ "$id" = "$uid" ]; then shell=$login; break; fi',
    `done < ${passwdPath}`,
    ...fallbacks.map((fallback) => `[ -x "$shell" ] || shell=${fallback}`),
    'exec "$shell" -l',
  ].join('\n');
}
