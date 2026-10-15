import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellcheck } from '@impz/test-utils/run-shellcheck';
import { defineCommand } from 'citty';
import { mainCommand } from './command-tree';
import { buildCompletionTree, renderCompletion } from './completion';
import type { CompletionNode } from './completion';
import { runCli } from './test-utils/start-cli';

test('#renderCompletion renders the bash script of a tree', () => {
  const tree = {
    path: 'impz',
    subcommands: ['ls', 'image'],
    flags: ['--host', '--help'],
    children: [
      { path: 'impz ls', subcommands: [], flags: ['--json', '--help'], children: [] },
      {
        path: 'impz image',
        subcommands: ['add'],
        flags: ['--help'],
        children: [
          { path: 'impz image add', subcommands: [], flags: ['--name', '--help'], children: [] },
        ],
      },
    ],
  };

  expect(renderCompletion('bash', tree)).toMatchInlineSnapshot(`
    "# bash completion for impz: eval "$(impz completion bash)"
    _impz_subcommands() {
      case "$1" in
        'impz') echo 'ls image' ;;
        'impz ls') echo '' ;;
        'impz image') echo 'add' ;;
        'impz image add') echo '' ;;
      esac
    }

    _impz_flags() {
      case "$1" in
        'impz') echo '--host --help' ;;
        'impz ls') echo '--json --help' ;;
        'impz image') echo '--help' ;;
        'impz image add') echo '--name --help' ;;
      esac
    }

    _impz() {
      local cur=\${COMP_WORDS[COMP_CWORD]} cmd=impz i
      for ((i = 1; i < COMP_CWORD; i++)); do
        case " $(_impz_subcommands "$cmd") " in
          *" \${COMP_WORDS[i]} "*) cmd="$cmd \${COMP_WORDS[i]}" ;;
        esac
      done
      local words
      if [[ $cur == -* ]]; then
        words=$(_impz_flags "$cmd")
      else
        words=$(_impz_subcommands "$cmd")
      fi
      # command and flag names hold no spaces or glob characters, so splitting
      # is safe; bash 3.2 on macOS has no mapfile
      # shellcheck disable=SC2207
      COMPREPLY=($(compgen -W "$words" -- "$cur"))
    }

    complete -F _impz impz
    "
  `);
});

test('#renderCompletion renders the zsh script of a tree', () => {
  const tree = {
    path: 'impz',
    subcommands: ['ls', 'image'],
    flags: ['--host', '--help'],
    children: [
      { path: 'impz ls', subcommands: [], flags: ['--json', '--help'], children: [] },
      {
        path: 'impz image',
        subcommands: ['add'],
        flags: ['--help'],
        children: [
          { path: 'impz image add', subcommands: [], flags: ['--name', '--help'], children: [] },
        ],
      },
    ],
  };

  expect(renderCompletion('zsh', tree)).toMatchInlineSnapshot(`
    "#compdef impz
    # zsh completion for impz: put it on $fpath as _impz, or eval "$(impz completion zsh)"
    _impz_subcommands() {
      case "$1" in
        'impz') echo 'ls image' ;;
        'impz ls') echo '' ;;
        'impz image') echo 'add' ;;
        'impz image add') echo '' ;;
      esac
    }

    _impz_flags() {
      case "$1" in
        'impz') echo '--host --help' ;;
        'impz ls') echo '--json --help' ;;
        'impz image') echo '--help' ;;
        'impz image add') echo '--name --help' ;;
      esac
    }

    _impz() {
      local cmd=impz i
      for ((i = 2; i < CURRENT; i++)); do
        if [[ " $(_impz_subcommands "$cmd") " == *" \${words[i]} "* ]]; then
          cmd="$cmd \${words[i]}"
        fi
      done
      if [[ \${words[CURRENT]} == -* ]]; then
        compadd -- \${=$(_impz_flags "$cmd")}
      else
        compadd -- \${=$(_impz_subcommands "$cmd")}
      fi
    }

    if [[ \${zsh_eval_context[-1]} == loadautofunc ]]; then
      _impz "$@"
    else
      compdef _impz impz
    fi
    "
  `);
});

test('#renderCompletion renders the fish script of a tree', () => {
  const tree = {
    path: 'impz',
    subcommands: ['ls', 'image'],
    flags: ['--host', '--help'],
    children: [
      { path: 'impz ls', subcommands: [], flags: ['--json', '--help'], children: [] },
      {
        path: 'impz image',
        subcommands: ['add'],
        flags: ['--help'],
        children: [
          { path: 'impz image add', subcommands: [], flags: ['--name', '--help'], children: [] },
        ],
      },
    ],
  };

  expect(renderCompletion('fish', tree)).toMatchInlineSnapshot(`
    "# fish completion for impz: impz completion fish | source
    function __impz_subcommands
      switch $argv[1]
        case 'impz'
          echo ls image
        case 'impz ls'
          echo 
        case 'impz image'
          echo add
        case 'impz image add'
          echo 
      end
    end

    function __impz_flags
      switch $argv[1]
        case 'impz'
          echo --host --help
        case 'impz ls'
          echo --json --help
        case 'impz image'
          echo --help
        case 'impz image add'
          echo --name --help
      end
    end

    function __impz_command
      set -l cmd impz
      for word in (commandline -opc)[2..-1]
        if contains -- $word (string split ' ' -- (__impz_subcommands "$cmd"))
          set cmd "$cmd $word"
        end
      end
      echo $cmd
    end

    complete -c impz -n 'not string match -q -- "-*" (commandline -ct)' -a '(string split " " -- (__impz_subcommands (__impz_command)))'
    complete -c impz -n 'string match -q -- "-*" (commandline -ct)' -f -a '(string split " " -- (__impz_flags (__impz_command)))'
    "
  `);
});

test.each(['bash', 'zsh', 'fish'] as const)(
  '#renderCompletion renders the same %p script for the same tree',
  async (shell) => {
    const tree = await buildCompletionTree(mainCommand);

    expect(renderCompletion(shell, tree)).toBe(renderCompletion(shell, tree));
  },
);

// shellcheck reads no zsh or fish, so only the bash script gets this check
test.skipIf(Bun.which('shellcheck') === null)(
  '#renderCompletion renders a bash script for the whole CLI that passes shellcheck',
  async () => {
    const tree = await buildCompletionTree(mainCommand);

    expect(runShellcheck(renderCompletion('bash', tree), 'bash')).toStrictEqual({
      exitCode: 0,
      output: '',
    });
  },
);

test('#buildCompletionTree lists the subcommands, flags, aliases and negations of a command', async () => {
  const command = defineCommand({
    meta: { name: 'impz' },
    args: {
      name: { type: 'positional' },
      verbose: { type: 'boolean', alias: 'v' },
      color: { type: 'boolean', default: true },
      output: { type: 'string', alias: ['o', 'out'] },
    },
    subCommands: {
      ls: () => defineCommand({ args: { json: { type: 'boolean' } } }),
    },
  });

  const tree = await buildCompletionTree(command);

  expect(tree).toStrictEqual({
    path: 'impz',
    subcommands: ['ls'],
    flags: [
      '--host',
      '--version',
      '--help',
      '--verbose',
      '-v',
      '--color',
      '--no-color',
      '--output',
      '-o',
      '--out',
    ],
    children: [{ path: 'impz ls', subcommands: [], flags: ['--json', '--help'], children: [] }],
  });
});

test('#completionCommand prints the bash script for the whole CLI', async () => {
  const tree = await buildCompletionTree(mainCommand);
  const result = await runCli({ args: ['completion', 'bash'] });

  expect(result).toStrictEqual({ stdout: renderCompletion('bash', tree), stderr: '', code: 0 });
});

test('#completionCommand refuses a shell it has no script for', async () => {
  const result = await runCli({ args: ['completion', 'tcsh'] });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: no completion for tcsh (try bash, zsh, fish)\n',
    code: 2,
  });
});

test('#buildCompletionTree gives impz login its own flags', async () => {
  const tree = await buildCompletionTree(mainCommand);

  expect(tree.children).toPartiallyContain({
    path: 'impz login',
    flags: expect.arrayContaining(['--no-verify']) as unknown,
  });
});

test('#buildCompletionTree holds impz completion itself, with no subcommands', async () => {
  const tree = await buildCompletionTree(mainCommand);

  expect(tree.children).toPartiallyContain({ path: 'impz completion', subcommands: [] });
});

test('#buildCompletionTree reaches the nested commands of the CLI', async () => {
  const tree = await buildCompletionTree(mainCommand);

  expect(
    tree.children.flatMap((node) => node.children.map((child) => child.path)),
  ).toIncludeAllMembers(['impz image build', 'impz host use']);
});

test('#buildCompletionTree gives the CLI the flags main handles itself', async () => {
  const tree = await buildCompletionTree(mainCommand);

  expect(tree.flags).toIncludeAllMembers(['--host', '--version', '--help']);
});

test.each(['bash', 'zsh', 'fish'] as const)(
  '#renderCompletion names every command path of the CLI in the %p script',
  async (shell) => {
    const tree = await buildCompletionTree(mainCommand);

    // every level of the tree, however deep: the walk visits what it appends
    const nodes: CompletionNode[] = [tree];

    for (const node of nodes) {
      nodes.push(...node.children);
    }

    const paths = nodes.map((node) => node.path);
    const script = renderCompletion(shell, tree);

    expect(paths).toSatisfyAll((path: string) => script.includes(`'${path}'`));
  },
);

test.each([
  ['impz ch', ['checkpoint', 'checkpoints']],
  ['impz --host work image ', ['add', 'build', 'builds', 'ls', 'rm']],
  ['impz login https://x --no', ['--no-verify']],
])('#renderCompletion completes %p in bash to %p', async (line, words) => {
  const tree = await buildCompletionTree(mainCommand);

  const typed = line.split(' ');

  const script = `${renderCompletion('bash', tree)}
COMP_WORDS=(${typed.map((word) => `'${word}'`).join(' ')})
COMP_CWORD=${String(typed.length - 1)}
_impz
printf '%s\\n' "\${COMPREPLY[@]}"`;

  const child = Bun.spawn(['bash', '-c', script], { stdout: 'pipe', stderr: 'pipe' });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: words.map((word) => `${word}\n`).join(''),
    stderr: '',
    code: 0,
  });
});

test.skipIf(Bun.which('zsh') === null)(
  '#renderCompletion writes a zsh script zsh parses',
  async () => {
    const tree = await buildCompletionTree(mainCommand);

    const child = Bun.spawn(['zsh', '-n'], {
      stdin: new TextEncoder().encode(renderCompletion('zsh', tree)),
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    expect({ stderr, code }).toStrictEqual({ stderr: '', code: 0 });
  },
);

test.skipIf(Bun.which('fish') === null).each([
  ['impz ch', ['checkpoint', 'checkpoints']],
  ['impz --host work image ', ['add', 'build', 'builds', 'ls', 'rm']],
  ['impz login https://x --no', ['--no-verify']],
])('#renderCompletion completes %p in fish to %p', async (line, words) => {
  // fish offers file names beside the commands, so it runs in an empty dir
  const dir = await mkdtemp(join(tmpdir(), 'imp-fish-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const tree = await buildCompletionTree(mainCommand);

  const script = `${renderCompletion('fish', tree)}\ncomplete -C '${line}'\n`;

  const child = Bun.spawn(['fish', '--no-config', '-c', script], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect({ stdout, stderr, code }).toStrictEqual({
    stdout: words.map((word) => `${word}\n`).join(''),
    stderr: '',
    code: 0,
  });
});
