import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// A tar of the tree `make` writes in a fresh directory under `dir`, its
// entries owned by root as an image's files are, through `tarArgs` such as
// --sparse; the tree goes once it is archived
export function buildTreeTar(
  dir: string,
  make: (tree: string) => void,
  tarArgs: readonly string[] = [],
): Uint8Array {
  const tree = mkdtempSync(join(dir, 'tree-'));

  make(tree);

  const tar = Bun.spawnSync(
    ['tar', '--owner=0', '--group=0', '--numeric-owner', ...tarArgs, '-C', tree, '-c', '.'],
    { maxBuffer: 2 * 1024 ** 3 },
  );

  rmSync(tree, { recursive: true, force: true });

  if (tar.exitCode !== 0) {
    throw new Error(`tar exited ${String(tar.exitCode)}: ${tar.stderr.toString().trim()}`);
  }

  return tar.stdout;
}
