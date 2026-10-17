import type { ArgSchema, LazyCommand, SubCommandable } from 'gunshi';
import { listEntries } from './list-entries';

export const SHELLS = ['bash', 'zsh', 'fish'] as const;

export type Shell = (typeof SHELLS)[number];

// One command in the tree a completion script walks: the words that may
// follow it.
export interface CompletionNode {
  // the command's words from the root, `impz checkpoint`
  readonly path: string;
  readonly subcommands: readonly string[];
  readonly flags: readonly string[];
  readonly children: readonly CompletionNode[];
}

// flags every command line takes before the command, outside any command
const ROOT_FLAGS = ['--host', '--version', '--help'];

// a command as gunshi holds it: the command, or the loader of a lazy one
type CommandEntry = SubCommandable | LazyCommand;

export async function buildCompletionTree(command: CommandEntry): Promise<CompletionNode> {
  const root = await buildNode(command, 'impz');

  return { ...root, flags: [...new Set([...ROOT_FLAGS, ...root.flags])] };
}

async function buildNode(command: CommandEntry, path: string): Promise<CompletionNode> {
  const resolved = await loadCommand(command);

  const args: Readonly<Record<string, ArgSchema>> = resolved.args ?? {};
  const subCommands = listSubCommands(resolved);
  const children: CompletionNode[] = [];

  for (const [name, child] of subCommands) {
    const node = await buildNode(child, `${path} ${name}`);

    children.push(node);
  }

  const flags = Object.entries(args).flatMap(([name, arg]) => {
    if (arg.type === 'positional' || arg.hidden === true) {
      return [];
    }

    const names = [`--${name}`];

    if (arg.type === 'boolean' && arg.negatable === true) {
      names.push(`--no-${name}`);
    }

    if (arg.short !== undefined) {
      names.push(`-${arg.short}`);
    }

    return names;
  });

  return {
    path,
    subcommands: subCommands.map(([name]) => name),
    flags: [...flags, '--help'],
    children,
  };
}

const RENDERERS: Readonly<Record<Shell, (nodes: readonly CompletionNode[]) => string>> = {
  bash: renderBash,
  zsh: renderZsh,
  fish: renderFish,
};

export function renderCompletion(shell: Shell, tree: CompletionNode): string {
  return RENDERERS[shell](collectNodes(tree));
}

// a command gunshi loads lazily, such as `completion`, loaded now
async function loadCommand(entry: CommandEntry): Promise<SubCommandable> {
  if (typeof entry !== 'function') {
    return entry;
  }

  const loaded = await entry();

  return typeof loaded === 'function' ? {} : loaded;
}

function listSubCommands(command: SubCommandable): [string, CommandEntry][] {
  const subCommands: Readonly<Record<string, CommandEntry>> | ReadonlyMap<string, CommandEntry> =
    command.subCommands ?? {};

  return listEntries(subCommands);
}

// the node and every node under it, depth first
export function collectNodes(node: CompletionNode): readonly CompletionNode[] {
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
  return `# bash completion for impz: eval "$(impz completion bash)"
${renderCases('_impz_subcommands', nodes, pickSubcommands)}

${renderCases('_impz_flags', nodes, pickFlags)}

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
`;
}

// `path` is a special zsh variable (tied to PATH), so the walk uses `cmd`.
function renderZsh(nodes: readonly CompletionNode[]): string {
  return `#compdef impz
# zsh completion for impz: put it on $fpath as _impz, or eval "$(impz completion zsh)"
${renderCases('_impz_subcommands', nodes, pickSubcommands)}

${renderCases('_impz_flags', nodes, pickFlags)}

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
`;
}

function renderFish(nodes: readonly CompletionNode[]): string {
  return `# fish completion for impz: impz completion fish | source
function __impz_subcommands
  switch $argv[1]
${renderFishCases(nodes, pickSubcommands)}
  end
end

function __impz_flags
  switch $argv[1]
${renderFishCases(nodes, pickFlags)}
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
`;
}

function renderFishCases(nodes: readonly CompletionNode[], pick: PickWords): string {
  return nodes
    .map((node) => `    case '${node.path}'\n      echo ${pick(node).join(' ')}`)
    .join('\n');
}
