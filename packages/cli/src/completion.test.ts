import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { mainCommand } from './command-tree';
import { buildCompletionTree, renderCompletion } from './completion';

test('#renderCompletion renders the bash script of a tree', () => {
  const tree = {
    path: 'imp',
    subcommands: ['ls', 'image'],
    flags: ['--host', '--help'],
    children: [
      { path: 'imp ls', subcommands: [], flags: ['--json', '--help'], children: [] },
      {
        path: 'imp image',
        subcommands: ['add'],
        flags: ['--help'],
        children: [
          { path: 'imp image add', subcommands: [], flags: ['--name', '--help'], children: [] },
        ],
      },
    ],
  };

  expect(renderCompletion('bash', tree)).toMatchInlineSnapshot(`
    "# bash completion for imp: eval "$(imp completion bash)"
    _imp_subcommands() {
      case "$1" in
        'imp') echo 'ls image' ;;
        'imp ls') echo '' ;;
        'imp image') echo 'add' ;;
        'imp image add') echo '' ;;
      esac
    }

    _imp_flags() {
      case "$1" in
        'imp') echo '--host --help' ;;
        'imp ls') echo '--json --help' ;;
        'imp image') echo '--help' ;;
        'imp image add') echo '--name --help' ;;
      esac
    }

    _imp() {
      local cur=\${COMP_WORDS[COMP_CWORD]} cmd=imp i
      for ((i = 1; i < COMP_CWORD; i++)); do
        case " $(_imp_subcommands "$cmd") " in
          *" \${COMP_WORDS[i]} "*) cmd="$cmd \${COMP_WORDS[i]}" ;;
        esac
      done
      local words
      if [[ $cur == -* ]]; then
        words=$(_imp_flags "$cmd")
      else
        words=$(_imp_subcommands "$cmd")
      fi
      # command and flag names hold no spaces or glob characters, so splitting
      # is safe; bash 3.2 on macOS has no mapfile
      # shellcheck disable=SC2207
      COMPREPLY=($(compgen -W "$words" -- "$cur"))
    }

    complete -F _imp imp
    "
  `);
});

test('#renderCompletion renders the zsh script of a tree', () => {
  const tree = {
    path: 'imp',
    subcommands: ['ls', 'image'],
    flags: ['--host', '--help'],
    children: [
      { path: 'imp ls', subcommands: [], flags: ['--json', '--help'], children: [] },
      {
        path: 'imp image',
        subcommands: ['add'],
        flags: ['--help'],
        children: [
          { path: 'imp image add', subcommands: [], flags: ['--name', '--help'], children: [] },
        ],
      },
    ],
  };

  expect(renderCompletion('zsh', tree)).toMatchInlineSnapshot(`
    "#compdef imp
    # zsh completion for imp: put it on $fpath as _imp, or eval "$(imp completion zsh)"
    _imp_subcommands() {
      case "$1" in
        'imp') echo 'ls image' ;;
        'imp ls') echo '' ;;
        'imp image') echo 'add' ;;
        'imp image add') echo '' ;;
      esac
    }

    _imp_flags() {
      case "$1" in
        'imp') echo '--host --help' ;;
        'imp ls') echo '--json --help' ;;
        'imp image') echo '--help' ;;
        'imp image add') echo '--name --help' ;;
      esac
    }

    _imp() {
      local cmd=imp i
      for ((i = 2; i < CURRENT; i++)); do
        if [[ " $(_imp_subcommands "$cmd") " == *" \${words[i]} "* ]]; then
          cmd="$cmd \${words[i]}"
        fi
      done
      if [[ \${words[CURRENT]} == -* ]]; then
        compadd -- \${=$(_imp_flags "$cmd")}
      else
        compadd -- \${=$(_imp_subcommands "$cmd")}
      fi
    }

    if [[ \${zsh_eval_context[-1]} == loadautofunc ]]; then
      _imp "$@"
    else
      compdef _imp imp
    fi
    "
  `);
});

test('#renderCompletion renders the fish script of a tree', () => {
  const tree = {
    path: 'imp',
    subcommands: ['ls', 'image'],
    flags: ['--host', '--help'],
    children: [
      { path: 'imp ls', subcommands: [], flags: ['--json', '--help'], children: [] },
      {
        path: 'imp image',
        subcommands: ['add'],
        flags: ['--help'],
        children: [
          { path: 'imp image add', subcommands: [], flags: ['--name', '--help'], children: [] },
        ],
      },
    ],
  };

  expect(renderCompletion('fish', tree)).toMatchInlineSnapshot(`
    "# fish completion for imp: imp completion fish | source
    function __imp_subcommands
      switch $argv[1]
        case 'imp'
          echo ls image
        case 'imp ls'
          echo 
        case 'imp image'
          echo add
        case 'imp image add'
          echo 
      end
    end

    function __imp_flags
      switch $argv[1]
        case 'imp'
          echo --host --help
        case 'imp ls'
          echo --json --help
        case 'imp image'
          echo --help
        case 'imp image add'
          echo --name --help
      end
    end

    function __imp_command
      set -l cmd imp
      for word in (commandline -opc)[2..-1]
        if contains -- $word (string split ' ' -- (__imp_subcommands "$cmd"))
          set cmd "$cmd $word"
        end
      end
      echo $cmd
    end

    complete -c imp -n 'not string match -q -- "-*" (commandline -ct)' -a '(string split " " -- (__imp_subcommands (__imp_command)))'
    complete -c imp -n 'string match -q -- "-*" (commandline -ct)' -f -a '(string split " " -- (__imp_flags (__imp_command)))'
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

test('#buildCompletionTree lists the subcommands, flags, aliases and negations of a command', async () => {
  const command = defineCommand({
    meta: { name: 'imp' },
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
    path: 'imp',
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
    children: [{ path: 'imp ls', subcommands: [], flags: ['--json', '--help'], children: [] }],
  });
});

test('#buildCompletionTree holds every command of the CLI', async () => {
  const tree = await buildCompletionTree(mainCommand);

  expect(tree.children).toPartiallyContain({
    path: 'imp login',
    flags: expect.arrayContaining(['--no-verify']) as unknown,
  });
});

test('#buildCompletionTree reaches the nested commands of the CLI', async () => {
  const tree = await buildCompletionTree(mainCommand);

  expect(
    tree.children.flatMap((node) => node.children.map((child) => child.path)),
  ).toIncludeAllMembers(['imp image build', 'imp host use']);
});

test('#buildCompletionTree gives the CLI the flags main handles itself', async () => {
  const tree = await buildCompletionTree(mainCommand);

  expect(tree.flags).toIncludeAllMembers(['--host', '--version', '--help']);
});

test.each(['bash', 'zsh', 'fish'] as const)(
  '#renderCompletion names every command path of the CLI in the %p script',
  async (shell) => {
    const tree = await buildCompletionTree(mainCommand);

    const paths = [tree, ...tree.children, ...tree.children.flatMap((node) => node.children)].map(
      (node) => node.path,
    );

    const script = renderCompletion(shell, tree);

    expect(paths).toSatisfyAll((path: string) => script.includes(`'${path}'`));
  },
);

test.each([
  ['imp ch', ['checkpoint', 'checkpoints']],
  ['imp --host work image ', ['add', 'build', 'ls', 'rm']],
  ['imp login https://x --no', ['--no-verify']],
])('#renderCompletion completes %p in bash to %p', async (line, words) => {
  const tree = await buildCompletionTree(mainCommand);

  const typed = line.split(' ');

  const script = `${renderCompletion('bash', tree)}
COMP_WORDS=(${typed.map((word) => `'${word}'`).join(' ')})
COMP_CWORD=${String(typed.length - 1)}
_imp
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
  ['imp ch', ['checkpoint', 'checkpoints']],
  ['imp --host work image ', ['add', 'build', 'ls', 'rm']],
  ['imp login https://x --no', ['--no-verify']],
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
