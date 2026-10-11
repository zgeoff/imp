import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Writes an executable <scripts>/<name> that stands in for one of the repo's
// scripts: it appends `<name> <args>` to calls, the log the stub binaries
// share, then runs body with the call's "$@".
export function createStubRepoScript(
  scripts: string,
  name: string,
  calls: string,
  body = '',
): string {
  const file = join(scripts, name);

  writeFileSync(
    file,
    `#!/bin/bash\nprintf '%s\\n' "${name} $*" >>'${calls.replaceAll("'", String.raw`'\''`)}'\n${body}\n`,
  );

  chmodSync(file, 0o755);

  return file;
}
