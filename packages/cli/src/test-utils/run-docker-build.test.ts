import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { checkDockerBuildx, runDockerBuild } from './run-docker-build';

async function setupTest() {
  const dir = await mkdtemp(join(tmpdir(), 'run-docker-build-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  return { dir };
}

test('#checkDockerBuildx answers yes for a docker whose buildx version succeeds', async () => {
  const ctx = await setupTest();

  const docker = join(ctx.dir, 'docker');

  await writeFile(docker, '#!/bin/sh\n[ "$1 $2" = "buildx version" ]\n', { mode: 0o755 });

  expect(checkDockerBuildx(docker)).toBeTrue();
});

test('#checkDockerBuildx answers no for a docker without buildx', async () => {
  const ctx = await setupTest();

  const docker = join(ctx.dir, 'docker');

  await writeFile(docker, '#!/bin/sh\necho "unknown command: docker buildx" >&2\nexit 1\n', {
    mode: 0o755,
  });

  expect(checkDockerBuildx(docker)).toBeFalse();
});

test('#checkDockerBuildx answers no when there is no docker at all', async () => {
  const ctx = await setupTest();

  expect(checkDockerBuildx(join(ctx.dir, 'docker'))).toBeFalse();
});

test.skipIf(!checkDockerBuildx())(
  '#runDockerBuild exports the files a context directory builds into',
  async () => {
    const ctx = await setupTest();

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
  '#runDockerBuild exports the files a context tar on stdin builds into',
  async () => {
    const ctx = await setupTest();

    const context = join(ctx.dir, 'context');
    const tarPath = join(ctx.dir, 'context.tar');

    await mkdir(context);
    await writeFile(join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
    await writeFile(join(context, 'app.js'), 'from the tar');

    const packed = Bun.spawnSync(['tar', '-cf', tarPath, '-C', context, '.']);

    invariant(packed.success);

    runDockerBuild({
      // a path inside the tar, as docker reads the Dockerfile from the context
      dockerfile: 'Dockerfile',
      context: { tarPath },
      dest: join(ctx.dir, 'out'),
    });

    expect(readFile(join(ctx.dir, 'out', 'app.js'), 'utf8')).resolves.toBe('from the tar');
  },
  120_000,
);

test.skipIf(!checkDockerBuildx())(
  '#runDockerBuild throws with docker’s message when the build fails',
  async () => {
    const ctx = await setupTest();

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
