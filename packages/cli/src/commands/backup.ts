import { defineCommand } from '../define-command';
import { formatBackupRun, formatBackupStatus, formatImps, formatOutput } from '../format-output';
import { runAction } from '../run-action';
import { UsageError } from '../usage-error';
import { jsonArg } from './common-args';

// a zone is required to be unambiguous; without one the time is UTC, never
// this machine's zone (docs/architecture/backups.md#restore)
const ZONED_TIME = /(?:Z|[+\-]\d{2}:?\d{2})$/iv;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/v;

export function parseUtcTime(text: string): Date {
  const zoned = ZONED_TIME.test(text) || DATE_ONLY.test(text) ? text : `${text}Z`;

  const time = new Date(zoned);

  if (Number.isNaN(time.getTime())) {
    throw new UsageError(`--at takes a time such as 2026-10-02T06:00Z, not ${text}`);
  }

  return time;
}

const lsCommand = defineCommand({
  meta: { name: 'ls', description: 'List the backups a restore can go back to, oldest first' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const status = await client.backups.list();

      console.log(formatOutput(status, context.args.json, formatBackupStatus));
    }),
});

const runCommand = defineCommand({
  meta: { name: 'run', description: 'Back up every imp now, as the schedule does' },
  args: { json: jsonArg },
  run: (context) =>
    runAction(context.host, async (client) => {
      const run = await client.backups.run();

      console.log(formatOutput(run, context.args.json, formatBackupRun));
    }),
});

const restoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description: 'Bring an imp, or every imp, back from a backup; restored imps are stopped',
  },
  args: {
    name: { type: 'positional', description: 'the imp to restore', required: false },
    all: { type: 'boolean', description: 'every imp in the backup' },
    at: { type: 'string', description: 'the newest backup at or before this time, in UTC' },
    as: { type: 'string', description: 'the restored imp’s name, when not its own' },
    merge: { type: 'boolean', description: 'with --all: add to a host that has imps already' },
    json: jsonArg,
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      const args = context.args;

      if ((args.all === true) === (args.name !== undefined)) {
        throw new UsageError('usage: imp backup restore <name> [--as <name>] | --all [--merge]');
      }

      const imps = await client.backups.restore({
        ...(args.name !== undefined && { name: args.name }),
        ...(args.all === true && { all: true }),
        ...(args.at !== undefined && { at: parseUtcTime(args.at) }),
        ...(args.as !== undefined && { as: args.as }),
        ...(args.merge === true && { merge: true }),
      });

      console.log(formatOutput(imps, args.json, formatImps));
    }),
});

const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Read back part of the repository and verify it (restic check)',
  },
  args: {
    subset: { type: 'string', description: 'how much to read: 5% (default), 1/10 or 2G' },
  },
  run: (context) =>
    runAction(context.host, async (client) => {
      await client.backups.check({
        ...(context.args.subset !== undefined && { subset: context.args.subset }),
      });

      console.log('the repository checks out');
    }),
});

export const backupCommand = defineCommand({
  meta: { name: 'backup', description: 'Off-host backups of every imp (restic)' },
  subCommands: { ls: lsCommand, run: runCommand, restore: restoreCommand, check: checkCommand },
});
