import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_REPO_ENV_VARS, createGitFreeEnv, runGitChecked, runGitCommand } from './git-env';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'git-env-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#GIT_REPO_ENV_VARS holds every variable this git ties to a repository', async () => {
  const listed = await runGitChecked(['git', 'rev-parse', '--local-env-vars']);

  expect(listed.trim().split('\n').toSorted()).toStrictEqual([...GIT_REPO_ENV_VARS].toSorted());
});

test('#createGitFreeEnv drops the repository variables and keeps the rest', () => {
  const env = createGitFreeEnv({
    PATH: '/usr/bin',
    GIT_DIR: '/repo/.git',
    GIT_WORK_TREE: '/repo',
    GIT_INDEX_FILE: '/repo/.git/index',
    GIT_AUTHOR_NAME: 'e2e',
    UNSET: undefined,
  });

  expect(env).toStrictEqual({ PATH: '/usr/bin', GIT_AUTHOR_NAME: 'e2e' });
});

test('#runGitCommand runs git in its own repo when this process names another', async () => {
  const ctx = await setupTest();

  const repo = join(ctx.dir, 'repo');
  const other = join(ctx.dir, 'other');

  await runGitChecked(['git', 'init', '-q', '-b', 'main', repo]);
  await runGitChecked(['git', 'init', '-q', '-b', 'main', other]);

  // as a pre-push hook exports it
  const before = process.env['GIT_DIR'];

  process.env['GIT_DIR'] = join(other, '.git');

  onTestFinished(() => {
    if (before === undefined) {
      delete process.env['GIT_DIR'];
    } else {
      process.env['GIT_DIR'] = before;
    }
  });

  const result = await runGitCommand(['git', '-C', repo, 'rev-parse', '--absolute-git-dir']);

  expect(result).toStrictEqual({ exitCode: 0, stdout: `${join(repo, '.git')}\n`, stderr: '' });
});

test('#runGitCommand passes the call’s env over this process’s', async () => {
  const result = await runGitCommand(['sh', '-c', 'printf %s "$GIT_AUTHOR_NAME"'], {
    env: { GIT_AUTHOR_NAME: 'e2e' },
  });

  expect(result.stdout).toBe('e2e');
});

test('#runGitChecked rejects on a non-zero exit', async () => {
  const ctx = await setupTest();

  const attempt = runGitChecked(['git', '-C', ctx.dir, 'rev-parse', 'main']);

  await Promise.allSettled([attempt]);

  expect(attempt).rejects.toThrow(/^git -C .* rev-parse main exited 128: /);
});
