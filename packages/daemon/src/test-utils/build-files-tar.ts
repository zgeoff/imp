import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A tar of a fresh directory in `dir` that holds these files, each named on
// tar's command line, as a builder's export streams an image's tree
export function buildFilesTar(dir: string, files: Readonly<Record<string, string>>): Uint8Array {
  const tree = mkdtempSync(join(dir, 'tree-'));

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(tree, name), content);
  }

  const tar = Bun.spawnSync(['tar', '-C', tree, '-c', ...Object.keys(files)]);

  if (tar.exitCode !== 0) {
    throw new Error(`tar exited ${String(tar.exitCode)}: ${tar.stderr.toString().trim()}`);
  }

  return tar.stdout;
}
