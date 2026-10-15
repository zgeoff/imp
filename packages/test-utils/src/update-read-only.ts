import { existsSync } from 'node:fs';

// Makes a tree read-only for this user, root too (chattr +i; root writes past
// any mode); returns the undo, which `stack` also runs while the tree exists.
export function updateReadOnly(stack: DisposableStack, path: string): () => void {
  const isRoot = process.getuid?.() === 0;
  const lock = isRoot ? ['chattr', '-R', '+i', path] : ['chmod', '-R', 'a-w', path];
  const unlock = isRoot ? ['chattr', '-R', '-i', path] : ['chmod', '-R', 'u+w', path];

  runChecked(lock);

  const updateWritable = () => {
    runChecked(unlock);
  };

  stack.defer(() => {
    if (existsSync(path)) {
      updateWritable();
    }
  });

  return updateWritable;
}

function runChecked(argv: readonly string[]): void {
  const result = Bun.spawnSync([...argv], { stderr: 'pipe' });

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
}
