import { expect, test } from 'bun:test';
import { mainCommand } from './command-tree';
import { SHELLS, buildCompletionTree, renderCompletion } from './completion';
import type { CompletionNode } from './completion';

const tree = await buildCompletionTree(mainCommand);

function listPaths(node: CompletionNode): string[] {
  return [node.path, ...node.children.flatMap((child) => listPaths(child))];
}

test('the tree holds every command, and main handles --host and --version', () => {
  const paths = listPaths(tree);

  expect(paths).toContain('imp image build');
  expect(paths).toContain('imp host use');
  expect(paths).toContain('imp completion');

  for (const flag of ['--host', '--version', '--help']) {
    expect(tree.flags).toContain(flag);
  }

  expect(tree.children.find((node) => node.path === 'imp login')?.flags).toContain('--no-verify');
});

for (const shell of SHELLS) {
  test(`the ${shell} script names every command path`, () => {
    const script = renderCompletion(shell, tree);

    for (const path of listPaths(tree)) {
      expect(script).toContain(`'${path}'`);
    }
  });
}

// runs the bash script's completion function as bash would on a <Tab>
async function runBashCompletion(line: string): Promise<string[]> {
  const words = line.split(' ');

  const script = `${renderCompletion('bash', tree)}
COMP_WORDS=(${words.map((word) => `'${word}'`).join(' ')})
COMP_CWORD=${String(words.length - 1)}
_imp
printf '%s\\n' "\${COMPREPLY[@]}"`;

  const child = Bun.spawn(['bash', '-c', script], { stdout: 'pipe', stderr: 'inherit' });

  const output = await new Response(child.stdout).text();

  const code = await child.exited;

  expect(code).toBe(0);

  return output.split('\n').filter((word) => word !== '');
}

test('bash completes commands, subcommands and flags', async () => {
  const commands = await runBashCompletion('imp ch');
  const subcommands = await runBashCompletion('imp --host work image ');
  const flags = await runBashCompletion('imp login https://x --no');

  expect(commands).toEqual(['checkpoint', 'checkpoints']);
  expect(subcommands).toEqual(['add', 'build', 'ls', 'rm']);
  expect(flags).toEqual(['--no-verify']);
});

test('zsh parses its script', async () => {
  const zsh = Bun.which('zsh');

  if (zsh === null) {
    return;
  }

  const child = Bun.spawn([zsh, '-n'], {
    stdin: new TextEncoder().encode(renderCompletion('zsh', tree)),
    stderr: 'pipe',
  });

  const stderr = await new Response(child.stderr).text();

  const code = await child.exited;

  expect(stderr).toBe('');
  expect(code).toBe(0);
});
