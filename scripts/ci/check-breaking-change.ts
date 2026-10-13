// .github/workflows/breaking-change.yml's check, which
// docs/runbooks/releasing.md#breaking-changes describes. Reads BASE_SHA,
// HEAD_SHA, PR_NUMBER, PR_TITLE and PR_BODY, and runs git in the working dir.
import * as z from 'zod';
import { ProtocolSchemaSchema } from '../../packages/api/src/protocols/build-protocol-schema';
import type { ProtocolSchema } from '../../packages/api/src/protocols/build-protocol-schema';
import { PROTOCOL_SCHEMA_FILE } from '../render-protocol-schema';
import { collectBreakingChanges } from './collect-breaking-changes';
import { isMarkedBreaking } from './is-marked-breaking';

const EnvSchema = z.object({
  BASE_SHA: z.string().min(1),
  HEAD_SHA: z.string().min(1),
  PR_NUMBER: z.coerce.number().int().positive(),
  PR_TITLE: z.string(),
  PR_BODY: z.string().default(''),
});

function main(): void {
  const env = EnvSchema.parse(process.env);
  const mergeBase = runGit(['merge-base', env.BASE_SHA, env.HEAD_SHA]).trim();
  const base = loadProtocolSchema(mergeBase);

  if (base === undefined) {
    console.log(
      `check-breaking-change: no ${PROTOCOL_SCHEMA_FILE} at the base; nothing to compare`,
    );

    return;
  }

  const head = loadProtocolSchema(env.HEAD_SHA);

  if (head === undefined) {
    console.error(`check-breaking-change: the pull request removes ${PROTOCOL_SCHEMA_FILE}`);
    process.exit(1);
  }

  const changes = collectBreakingChanges(base, head);

  if (changes.length === 0) {
    console.log('check-breaking-change: no breaking change to the protocol');

    return;
  }

  const commits = runGit(['log', '--reverse', '--format=%B%x00', `${mergeBase}..${env.HEAD_SHA}`])
    .split('\0')
    .map((message) => message.trim())
    .filter((message) => message !== '');

  const list = changes.map((change) => `  - ${change}`).join('\n');
  const pr = { number: env.PR_NUMBER, title: env.PR_TITLE, body: env.PR_BODY, commits };

  if (isMarkedBreaking(pr)) {
    console.log(
      `check-breaking-change: breaking changes, marked so the release bumps the major:\n${list}`,
    );

    return;
  }

  console.error(
    `check-breaking-change: this pull request breaks the protocol a client of the same major speaks:\n${list}\n\n` +
      'Keep the change compatible, or mark it so release-please bumps the major: a `!` after the\n' +
      "type, as in `feat(#740)!: …`, in the PR title (several commits) or in the commit's subject\n" +
      '(one commit), or a `BREAKING CHANGE: <what breaks>` footer in a commit message.',
  );

  process.exit(1);
}

function runGit(args: readonly string[]): string {
  const result = Bun.spawnSync(['git', ...args], { stderr: 'pipe' });

  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`);
  }

  return result.stdout.toString();
}

// the file at a commit; undefined when the commit has none
function loadProtocolSchema(commit: string): ProtocolSchema | undefined {
  const result = Bun.spawnSync(['git', 'show', `${commit}:${PROTOCOL_SCHEMA_FILE}`], {
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();

    if (/does not exist|exists on disk, but not in/u.test(stderr)) {
      return undefined;
    }

    throw new Error(`git show ${commit}:${PROTOCOL_SCHEMA_FILE}: ${stderr.trim()}`);
  }

  return ProtocolSchemaSchema.parse(JSON.parse(result.stdout.toString()));
}

if (import.meta.main) {
  main();
}
