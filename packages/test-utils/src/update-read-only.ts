import { existsSync } from 'node:fs';

// Makes a tree read-only for this user, root too (chattr +i; root writes past
// any mode); returns the undo, which `stack` also runs while the tree exists.
export function updateReadOnly(stack: Readonly<DisposableStack>, path: string): () => void {
  const isRoot = process.getuid?.() === 0;

  // chattr refuses a symlink, which holds no flags; chmod -R passes over one
  const lock = isRoot ? buildChattrArgv(path, '+i') : ['chmod', '-R', 'a-w', path];
  const unlock = isRoot ? buildChattrArgv(path, '-i') : ['chmod', '-R', 'u+w', path];

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

function buildChattrArgv(path: string, flag: string): readonly string[] {
  return ['find', path, '!', '-type', 'l', '-exec', 'chattr', flag, '{}', '+'];
}

function runChecked(argv: readonly string[]): void {
  const result = Bun.spawnSync([...argv], { stderr: 'pipe' });

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
}
