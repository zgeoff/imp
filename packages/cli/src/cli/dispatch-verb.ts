import type { CommandContext } from 'gunshi';

type VerbRunner = (operands: readonly string[]) => Promise<void>;

// The words a user typed after the command's own name, such as
// `rm box cp1` for `impz checkpoint rm box cp1`.
export function listOperands(ctx: Readonly<CommandContext<never>>): string[] {
  return ctx.positionals.slice(ctx.commandPath.length);
}

// `impz checkpoint rm <name> <checkpoint>` shares its command with
// `impz checkpoint <name> [label]`: a first word that names a verb runs it on
// the words after it, and any other runs the command's own form.
export async function dispatchVerb(
  operands: readonly string[],
  verbs: Readonly<Record<string, VerbRunner>>,
  runOwnForm: () => Promise<void>,
): Promise<void> {
  const [verb, ...rest] = operands;
  const runVerb = verb === undefined || !Object.hasOwn(verbs, verb) ? undefined : verbs[verb];

  await (runVerb === undefined ? runOwnForm() : runVerb(rest));
}
