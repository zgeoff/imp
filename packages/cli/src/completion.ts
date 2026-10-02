import type { ArgsDef, CommandDef, Resolvable } from 'citty';

export const SHELLS = ['bash', 'zsh', 'fish'] as const;

export type Shell = (typeof SHELLS)[number];

// One command in the tree a completion script walks: the words that may
// follow it.
export interface CompletionNode {
  // the command's words from the root, `imp checkpoint`
  readonly path: string;
  readonly subcommands: readonly string[];
  readonly flags: readonly string[];
  readonly children: readonly CompletionNode[];
}

// flags main handles itself, outside any citty command
const ROOT_FLAGS = ['--host', '--version', '--help'];

/* oxlint-disable prefer-readonly-parameter-types -- citty's CommandDef is mutable all the way down */
export async function buildCompletionTree<T extends ArgsDef>(
  command: CommandDef<T>,
): Promise<CompletionNode> {
  const root = await buildNode(command, 'imp');

  return { ...root, flags: [...new Set([...ROOT_FLAGS, ...root.flags])] };
}

async function buildNode<T extends ArgsDef>(
  command: CommandDef<T>,
  path: string,
): Promise<CompletionNode> {
  const resolvedArgs: ArgsDef | undefined = await resolve(command.args);
  const resolvedSubCommands = await resolve(command.subCommands);

  const args = resolvedArgs ?? {};
  const subCommands = resolvedSubCommands ?? {};
  const children: CompletionNode[] = [];

  for (const [name, child] of Object.entries(subCommands)) {
    const resolved = await resolve(child);

    if (resolved !== undefined) {
      const node = await buildNode(resolved, `${path} ${name}`);

      children.push(node);
    }
  }

  const flags = Object.entries(args).flatMap(([name, arg]) => {
    if (arg.type === 'positional') {
      return [];
    }

    const aliases = 'alias' in arg ? arg.alias : undefined;

    const short = (typeof aliases === 'string' ? [aliases] : (aliases ?? [])).map((alias) =>
      alias.length === 1 ? `-${alias}` : `--${alias}`,
    );

    const names = [`--${name}`];

    if (arg.type === 'boolean' && arg.default === true) {
      names.push(`--no-${name}`);
    }

    names.push(...short);

    return names;
  });

  return {
    path,
    subcommands: Object.keys(subCommands),
    flags: [...flags, '--help'],
    children,
  };
}

/* oxlint-enable prefer-readonly-parameter-types */

const RENDERERS: Readonly<Record<Shell, (nodes: readonly CompletionNode[]) => string>> = {
  bash: renderBash,
  zsh: renderZsh,
  fish: renderFish,
};

export function renderCompletion(shell: Shell, tree: CompletionNode): string {
  return RENDERERS[shell](collectNodes(tree));
}

// citty's own resolver is not exported
function resolve<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  // oxlint-disable-next-line no-unsafe-type-assertion -- no command or args object is a function
  const resolved = typeof value === 'function' ? (value as () => T | Promise<T>)() : value;

  return Promise.resolve(resolved);
}

function collectNodes(node: CompletionNode): readonly CompletionNode[] {
  return [node, ...node.children.flatMap((child) => collectNodes(child))];
}

type PickWords = (node: CompletionNode) => readonly string[];

function pickSubcommands(node: CompletionNode): readonly string[] {
  return node.subcommands;
}

function pickFlags(node: CompletionNode): readonly string[] {
  return node.flags;
}

// The bash and zsh scripts share their shape: a `case` that maps a command
// path to its subcommands and to its flags, and a loop that walks the typed
// words down that tree. No associative arrays, so macOS's bash 3.2 runs it.
function renderCases(fn: string, nodes: readonly CompletionNode[], pick: PickWords): string {
  const cases = nodes
    .map((node) => `    '${node.path}') echo '${pick(node).join(' ')}' ;;`)
    .join('\n');

  return `${fn}() {\n  case "$1" in\n${cases}\n  esac\n}`;
}

function renderBash(nodes: readonly CompletionNode[]): string {
  return `# bash completion for imp: eval "$(imp completion bash)"
${renderCases('_imp_subcommands', nodes, pickSubcommands)}

${renderCases('_imp_flags', nodes, pickFlags)}

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
`;
}

// `path` is a special zsh variable (tied to PATH), so the walk uses `cmd`.
function renderZsh(nodes: readonly CompletionNode[]): string {
  return `#compdef imp
# zsh completion for imp: put it on $fpath as _imp, or eval "$(imp completion zsh)"
${renderCases('_imp_subcommands', nodes, pickSubcommands)}

${renderCases('_imp_flags', nodes, pickFlags)}

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
`;
}

function renderFish(nodes: readonly CompletionNode[]): string {
  return `# fish completion for imp: imp completion fish | source
function __imp_subcommands
  switch $argv[1]
${renderFishCases(nodes, pickSubcommands)}
  end
end

function __imp_flags
  switch $argv[1]
${renderFishCases(nodes, pickFlags)}
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
`;
}

function renderFishCases(nodes: readonly CompletionNode[], pick: PickWords): string {
  return nodes
    .map((node) => `    case '${node.path}'\n      echo ${pick(node).join(' ')}`)
    .join('\n');
}
