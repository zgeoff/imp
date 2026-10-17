import { defineWithTypes } from 'gunshi';
import type { SubCommandable } from 'gunshi';
import type { ImpzExtension } from './impz-plugin';
import { renderUsage } from './render-usage';
import { UsageError } from './usage-error';

interface ImpzParams {
  readonly extensions: { readonly impz: ImpzExtension };
}

// gunshi's define, with `ctx.extensions.impz` typed for every command
export const defineCommand = defineWithTypes<ImpzParams>();

interface GroupDefinition {
  readonly name: string;
  readonly description: string;
  readonly subCommands: Readonly<Record<string, SubCommandable>>;
}

// A command that only holds others, such as `impz token`: alone, it prints
// its usage and fails as a usage error.
export function defineGroup(definition: Readonly<GroupDefinition>) {
  return defineCommand({
    ...definition,
    run: (ctx) => {
      ctx.extensions.impz.io.print(renderUsage(ctx));
      throw new UsageError('no command specified');
    },
  });
}
