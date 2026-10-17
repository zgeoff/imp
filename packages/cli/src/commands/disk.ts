import { defineCommand, defineGroup } from '../define-command';
import { formatImp, formatOutput } from '../format-output';
import { parseSize } from '../parse-size';
import { runAction } from '../run-action';
import { jsonArg, nameArg } from './common-args';

const resizeCommand = defineCommand({
  name: 'resize',
  description: "Grow an imp's disk; the guest's filesystem grows into it (never shrinks)",
  args: {
    name: nameArg,
    size: { type: 'positional', description: 'new disk size, with a unit (64g)', required: true },
    json: jsonArg,
  },
  run: (ctx) =>
    runAction(ctx.extensions.impz, async (client) => {
      const imp = await client.imps.resizeDisk({
        name: ctx.values.name,
        diskMib: parseSize(ctx.values.size),
      });

      ctx.extensions.impz.io.print(formatOutput(imp, ctx.values.json, formatImp));
    }),
});

export const diskCommand = defineGroup({
  name: 'disk',
  description: 'Manage imp disks',
  subCommands: { resize: resizeCommand },
});
