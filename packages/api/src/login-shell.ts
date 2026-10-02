// The login shell of the user an exec runs as, from the image's /etc/passwd,
// else bash, else sh. Plain sh: the image may have neither awk nor getent.
// `imp console` and the SSH gateway run it as `/bin/sh -c CONSOLE_SHELL`.
export const CONSOLE_SHELL = [
  'uid=$(id -u 2>/dev/null) || uid=0',
  'shell=',
  'while IFS=: read -r _ _ id _ _ _ login; do',
  '  if [ "$id" = "$uid" ]; then shell=$login; break; fi',
  'done < /etc/passwd',
  '[ -x "$shell" ] || shell=/bin/bash',
  '[ -x "$shell" ] || shell=/bin/sh',
  'exec "$shell" -l',
].join('\n');
