import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDockerBuildx, runDockerBuild } from './run-docker-build';

async function setupTest() {
  await using stack = new AsyncDisposableStack();

  const dir = await mkdtemp(join(tmpdir(), 'run-docker-build-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  const owned = stack.move();

  return { dir, [Symbol.asyncDispose]: () => owned.disposeAsync() };
}

test('#checkDockerBuildx answers whether docker buildx runs', () => {
  const ran = Bun.spawnSync(['docker', 'buildx', 'version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  });

  expect(checkDockerBuildx()).toBe(ran.success);
});

test.skipIf(!checkDockerBuildx())(
  '#runDockerBuild exports the files a context directory builds into',
  async () => {
    await using ctx = await setupTest();

    const context = join(ctx.dir, 'context');

    await mkdir(context);
    await writeFile(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
    await writeFile(join(context, 'app.js'), 'app');

    runDockerBuild({
      dockerfile: join(context, 'Dockerfile'),
      context: { dir: context },
      dest: join(ctx.dir, 'out'),
    });

    expect(readFile(join(ctx.dir, 'out', 'app.js'), 'utf8')).resolves.toBe('app');
  },
  120_000,
);

test.skipIf(!checkDockerBuildx())(
  '#runDockerBuild throws with docker’s message when the build fails',
  async () => {
    await using ctx = await setupTest();

    const context = join(ctx.dir, 'context');

    await mkdir(context);
    await writeFile(join(context, 'Dockerfile'), 'NOT A DOCKERFILE\n');

    expect(() => {
      runDockerBuild({
        dockerfile: join(context, 'Dockerfile'),
        context: { dir: context },
        dest: join(ctx.dir, 'out'),
      });
    }).toThrowWithMessage(Error, /^docker buildx build --quiet -f .+unknown instruction/su);
  },
  120_000,
);
