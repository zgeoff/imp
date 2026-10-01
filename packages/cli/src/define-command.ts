import { defineCommand as defineCittyCommand } from 'citty';
import type { ArgsDef, CommandDef } from 'citty';

// citty's defineCommand, but a flag the command does not declare is an
// error: citty keeps it (`--checkpoint cp1` parses to `checkpoint: true`) and
// the command would run as if it were not there.
// oxlint-disable-next-line prefer-readonly-parameter-types -- citty's CommandDef is mutable all the way down
export function defineCommand<T extends ArgsDef>(def: CommandDef<T> & { args?: T }): CommandDef<T> {
  if (def.run === undefined) {
    return defineCittyCommand(def);
  }

  const run = def.run;
  const known = listKnownKeys(def.args ?? {});
  const command = typeof def.meta === 'object' && 'name' in def.meta ? def.meta.name : undefined;

  return defineCittyCommand({
    ...def,
    run: async (context) => {
      const unknown = Object.keys(context.args).filter((key) => !known.has(key));

      if (unknown.length > 0) {
        const flags = unknown.map((flag) => (flag.length === 1 ? `-${flag}` : `--${flag}`));
        const noun = flags.length === 1 ? 'flag' : 'flags';
        const where = command === undefined ? '' : ` for ${command}`;

        console.error(`imp: unknown ${noun} ${flags.join(', ')}${where} (see --help)`);

        process.exitCode = 2;

        return;
      }

      await run(context);
    },
  });
}

// the keys citty can parse for these arguments: each name in its camelCase
// and kebab-case spellings, and its aliases
// oxlint-disable-next-line prefer-readonly-parameter-types -- citty's ArgsDef
function listKnownKeys(args: ArgsDef): ReadonlySet<string> {
  const known = new Set(['_', 'help', 'h']);

  for (const [name, arg] of Object.entries(args)) {
    known.add(name).add(toCamelCase(name)).add(toKebabCase(name));

    const aliases = 'alias' in arg ? arg.alias : undefined;

    for (const alias of typeof aliases === 'string' ? [aliases] : (aliases ?? [])) {
      known.add(alias);
    }
  }

  return known;
}

function toCamelCase(name: string): string {
  return name.replaceAll(/-(?<letter>[a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

function toKebabCase(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
