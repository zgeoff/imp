import { defineCommand } from '../define-command';
import { formatImp, formatOutput } from '../format-output';
import { parseSize } from '../parse-size';
import { runAction } from '../run-action';
import { jsonArg, nameArg } from './common-args';

const resizeCommand = defineCommand({
  meta: {
    name: 'resize',
    description: "Grow an imp's disk; the guest's filesystem grows into it (never shrinks)",
  },
  args: {
    name: nameArg,
    size: { type: 'positional', description: 'new disk size, with a unit (64g)', required: true },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const imp = await client.imps.resizeDisk({
        name: context.args.name,
        diskMib: parseSize(context.args.size),
      });

      console.log(formatOutput(imp, context.args.json, formatImp));
    }),
});

export const diskCommand = defineCommand({
  meta: { name: 'disk', description: 'Manage imp disks' },
  subCommands: { resize: resizeCommand },
});
