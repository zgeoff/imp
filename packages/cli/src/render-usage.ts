import type { ArgSchema, CommandContext, SubCommandable } from 'gunshi';

// The `--help` of a command as impz has always printed it. A command shows
// its parent's name beside its own, and the root and its direct commands
// show the version.
export function renderUsage(ctx: Readonly<CommandContext<never>>): string {
  const path = ctx.commandPath;
  const parent = path.length === 1 ? (ctx.env.name ?? '') : (path.at(-2) ?? '');
  const own = path.at(-1) ?? ctx.env.name ?? '';
  const commandName = path.length === 0 ? own : `${parent} ${own}`;
  const version = path.length <= 1 ? ctx.env.version : undefined;
  const argLines: [string, string][] = [];
  const posLines: [string, string][] = [];
  const usageLine: string[] = [];

  for (const [name, arg] of listShownArgs(ctx)) {
    if (arg.type === 'positional') {
      const upper = name.toUpperCase();
      const isRequired = isPositionalRequired(arg);

      posLines.push([upper + renderValueHint(name, arg), renderDescription(arg, isRequired)]);

      const shown = isRequired ? `<${upper}>` : `[${upper}]`;

      usageLine.push(shown);
    } else {
      const isRequired = arg.required === true && arg.default === undefined;
      const flags = [...(arg.short === undefined ? [] : [`-${arg.short}`]), `--${name}`];

      argLines.push([
        flags.join(', ') + renderValueHint(name, arg),
        renderDescription(arg, isRequired),
      ]);

      if (arg.type === 'boolean' && arg.negatable === true) {
        argLines.push([`--no-${name}`, readNegativeDescription(arg)]);
      }

      if (isRequired) {
        usageLine.push(`--${name}${renderValueHint(name, arg)}`);
      }
    }
  }

  const commandLines = listCommandLines(ctx);

  if (commandLines.length > 0) {
    usageLine.push(commandLines.map(([name]) => name).join('|'));
  }

  const hasOptions = argLines.length > 0 || posLines.length > 0;
  const named = version === undefined ? commandName : `${commandName} v${version}`;

  const lines = [
    `${ctx.description ?? ''} (${named})`,
    '',
    `USAGE ${commandName}${hasOptions ? ' [OPTIONS]' : ''} ${usageLine.join(' ')}`,
    '',
  ];

  if (posLines.length > 0) {
    lines.push('ARGUMENTS', '', formatColumns(posLines), '');
  }

  if (argLines.length > 0) {
    lines.push('OPTIONS', '', formatColumns(argLines), '');
  }

  if (commandLines.length > 0) {
    lines.push(
      'COMMANDS',
      '',
      formatColumns(commandLines),
      '',
      `Use ${commandName} <command> --help for more information about a command.`,
    );
  }

  // the blank line that ends it, as impz has always printed it
  return `${lines.join('\n')}\n`;
}

// gunshi's rule: a positional is required unless it says otherwise or has a
// default, and one that takes many only when it says so
function isPositionalRequired(arg: Readonly<ArgSchema>): boolean {
  if (arg.multiple === true) {
    return arg.required === true;
  }

  return arg.required !== false && arg.default === undefined;
}

// the flags gunshi gives every command, which the help never listed
const BUILTIN_FLAGS = new Set(['help', 'version']);

// the command's own arguments; `--host` goes anywhere, so only the root
// lists it
function listShownArgs(ctx: Readonly<CommandContext<never>>): [string, ArgSchema][] {
  const globals = ctx.env.globalOptions ?? new Map<string, ArgSchema>();
  const args: Readonly<Record<string, ArgSchema>> = ctx.args;

  return Object.entries(args).filter(
    ([name, arg]) =>
      arg.hidden !== true &&
      !BUILTIN_FLAGS.has(name) &&
      (ctx.commandPath.length === 0 || !globals.has(name)),
  );
}

// gunshi hands a renderer the commands beside the one it renders, that
// command among them; the root's are those, but for the root itself
function listCommandLines(ctx: Readonly<CommandContext<never>>): [string, string][] {
  const siblings: ReadonlyMap<string, SubCommandable> = ctx.env.subCommands ?? new Map();
  const own = ctx.commandPath.at(-1);

  const subCommands =
    own === undefined
      ? [...siblings].filter(([, sub]) => sub !== ctx.env.entryCommand)
      : listOwnSubCommands(siblings.get(own));

  return subCommands.map(([name, sub]) => [name, sub.description ?? '']);
}

function listOwnSubCommands(command: SubCommandable | undefined): [string, SubCommandable][] {
  const subCommands:
    | Readonly<Record<string, SubCommandable>>
    | ReadonlyMap<string, SubCommandable> = command?.subCommands ?? {};

  return subCommands instanceof Map ? [...subCommands] : Object.entries(subCommands);
}

// `=<name>` after a flag that takes a value, its name in snake case
function renderValueHint(name: string, arg: Readonly<ArgSchema>): string {
  if (arg.type === 'positional' || arg.type === 'boolean') {
    return '';
  }

  return `=<${name.replaceAll('-', '_')}>`;
}

// what `--no-<flag>` does, which a negatable flag may say beside its own
// description
function readNegativeDescription(arg: Readonly<ArgSchema>): string {
  const text: unknown = 'negativeDescription' in arg ? arg.negativeDescription : undefined;

  return typeof text === 'string' ? text : '';
}

function renderDescription(arg: Readonly<ArgSchema>, isRequired: boolean): string {
  return [
    arg.description,
    isRequired ? '(Required)' : '',
    arg.default === undefined ? '' : `(Default: ${String(arg.default)})`,
  ]
    .filter(Boolean)
    .join(' ');
}

// two-space indented columns: the first right-aligned, the rest padded to
// the widest
function formatColumns(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];

  for (const row of rows) {
    for (const [index, cell] of row.entries()) {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    }
  }

  return rows
    .map((row) =>
      row
        .map((cell, index) => {
          const width = widths[index] ?? 0;

          return `  ${index === 0 ? cell.padStart(width) : cell.padEnd(width)}`;
        })
        .join('  '),
    )
    .join('\n');
}
