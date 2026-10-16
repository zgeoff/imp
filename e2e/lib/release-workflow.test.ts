import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@impz/test-utils/invariant';
import { buildStubRegistryDocker } from '../../scripts/test-utils/build-stub-registry-docker';
import { createStubBin } from '../../scripts/test-utils/create-stub-bin';
import { parseReleaseWorkflow } from '../../scripts/test-utils/parse-release-workflow';
import { createGitFreeEnv } from './git-env';

// The base job publishes imp-base, which other images pin by digest, so a published tag must
// never move (docs/runbooks/releasing.md). The Plan step's tests run its shell as Actions does (bash -eo
// pipefail), with a stub docker and gh on PATH and a checked-out tree in a scratch directory.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-release-workflow-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the checked-out tree the Plan step reads, and the file Actions collects its outputs from
  mkdirSync(join(dir, 'tree', 'images', 'base'), { recursive: true });
  mkdirSync(join(dir, 'tree', 'host'));
  mkdirSync(join(dir, 'tree', 'scripts', 'release'), { recursive: true });
  writeFileSync(join(dir, 'outputs'), '');

  return {
    dir,
    tree: join(dir, 'tree'),
    outputs: join(dir, 'outputs'),
  };
}

test('it runs the base job after the smoke checks, with the image job permissions', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.base.needs).toContain('smoke');
  expect(jobs.base.permissions).toStrictEqual(jobs.image.permissions);
});

test('it checks out the tag being built in the base job', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  const checkout = jobs.base.steps.find(
    (step) => step.uses?.startsWith('actions/checkout@') === true,
  );

  // an Actions expression, not a template placeholder
  expect(checkout?.with).toContainEntry(['ref', `\${{ inputs.tag || github.sha }}`]);
});

test('it labels the base image with the commit it builds', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  const build = jobs.base.steps.find((step) => step.run?.includes('docker buildx build') === true);

  expect(build?.run).toInclude('git rev-parse HEAD');
});

test('it builds the base image for linux/amd64 only', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  const build = jobs.base.steps.find((step) => step.run?.includes('docker buildx build') === true);
  const platforms = [...(build?.run ?? '').matchAll(/--platform[ =](?<list>\S+)/gv)];

  expect(platforms.map((match) => match.groups?.['list'])).toStrictEqual(['linux/amd64']);
});

test('it plans before any build, and builds, checks, pushes and attests only on push', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  const after = jobs.base.steps.slice(jobs.base.steps.findIndex((step) => step.id === 'plan') + 1);

  expect(after.map((step) => [step.name, step.if])).toStrictEqual([
    ['Build image', "steps.plan.outputs.action == 'push'"],
    ['Check image', "steps.plan.outputs.action == 'push'"],
    ['Push image', "steps.plan.outputs.action == 'push'"],
    ['Attest image', "steps.plan.outputs.action == 'push'"],
  ]);
});

test('it pushes a tag the registry does not have', () => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const docker = createStubBin(ctx.dir, 'docker', buildStubRegistryDocker({ kind: 'missing' }));

  invariant(plan);
  writeFileSync(join(ctx.tree, 'scripts/release/check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images/base/Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', plan], {
    cwd: ctx.tree,
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=push\n');
});

// a republished tag from before scripts/release/ keeps its check script in host/
test('it pushes a missing tag of a tree that keeps its check script in host/', () => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const docker = createStubBin(ctx.dir, 'docker', buildStubRegistryDocker({ kind: 'missing' }));

  invariant(plan);
  writeFileSync(join(ctx.tree, 'host/check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images/base/Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', plan], {
    cwd: ctx.tree,
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=push\n');
});

test('it leaves an attested existing tag alone, with a notice', () => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: digest }),
  );

  const gh = createStubBin(ctx.dir, 'gh', 'exit 0');

  invariant(plan);
  writeFileSync(join(ctx.tree, 'scripts/release/check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images/base/Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', plan], {
    cwd: ctx.tree,
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=skip\n');

  expect(result.stdout.toString()).toInclude(
    `::notice::ghcr.io/zgeoff/imp-base:1.2.3 exists already at ${digest}`,
  );

  expect(readFileSync(gh.calls, 'utf8')).toInclude(
    `gh attestation verify oci://ghcr.io/zgeoff/imp-base@${digest} --repo zgeoff/impz\n`,
  );
});

test('it fails the job on an existing tag without an attestation, and plans nothing', () => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: digest }),
  );

  createStubBin(ctx.dir, 'gh', 'exit 1');
  invariant(plan);
  writeFileSync(join(ctx.tree, 'scripts/release/check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images/base/Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', plan], {
    cwd: ctx.tree,
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');

  expect(result.stdout.toString()).toInclude(
    `::error::ghcr.io/zgeoff/imp-base:1.2.3 exists at ${digest} with no attestation`,
  );
});

test('it fails the job on an existing tag whose digest is not a sha256', () => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: 'WARN: something\nsha256:abc' }),
  );

  createStubBin(ctx.dir, 'gh', 'exit 0');
  invariant(plan);
  writeFileSync(join(ctx.tree, 'scripts/release/check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images/base/Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', plan], {
    cwd: ctx.tree,
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
  expect(result.stdout.toString()).toInclude('exists, but the registry gave no valid digest');
});

test.each([
  ['a denied request', 'ERROR: failed to authorize: 403 Forbidden'],
  ['a missing blob', 'ERROR: blob sha256:abc not found'],
])('it fails the job, planning nothing, on %s from the registry', (_reason, error) => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'failed', error }),
  );

  invariant(plan);
  writeFileSync(join(ctx.tree, 'scripts/release/check-base-image.sh'), '');

  writeFileSync(
    join(ctx.tree, 'images/base/Dockerfile'),
    'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
  );

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', plan], {
    cwd: ctx.tree,
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');

  expect(result.stderr.toString()).toBe(
    `cannot tell whether ghcr.io/zgeoff/imp-base:1.2.3 exists:\n${error}\n`,
  );
});

test('it skips a release from before imp-base without asking the registry', () => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const docker = createStubBin(ctx.dir, 'docker', buildStubRegistryDocker({ kind: 'missing' }));

  invariant(plan);
  writeFileSync(join(ctx.tree, 'images/base/Dockerfile'), 'FROM ubuntu:24.04\n');

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', plan], {
    cwd: ctx.tree,
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '1.2.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=skip\n');

  expect(result.stdout.toString()).toStartWith(
    '::notice::this tree predates the published imp-base',
  );

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it tags imp-base latest nowhere in the workflow', () => {
  const text = readFileSync(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );

  expect(
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /BASE_IMAGE|imp-base/v.test(line) && line.includes('latest')),
  ).toStrictEqual([]);
});

test('it never holds a release up on the base job', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.publish.needs).not.toContain('base');
});

// The lock that keeps an older release from moving `latest` back: one group for every release
// run, which keeps each waiting job rather than cancelling it.
test('it holds the latest job under one queued group that every release run shares', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.latest.concurrency).toStrictEqual({
    group: 'latest-tag',
    'cancel-in-progress': false,
    queue: 'max',
  });
});

test('it moves latest in one line of the whole workflow', () => {
  const text = readFileSync(
    new URL('../../.github/workflows/release.yml', import.meta.url),
    'utf8',
  );

  expect(
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => line.includes(':latest')),
  ).toStrictEqual([
    '          docker buildx imagetools create -t "$IMAGE:latest" "$IMAGE:$VERSION"',
  ]);
});

test('it looks up the newest release in the same step that moves latest', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  const step = jobs.latest.steps.find((candidate) => candidate.id === 'latest')?.run;

  expect(step).toInclude('gh release view');
  expect(step).toInclude('docker buildx imagetools create -t "$IMAGE:latest"');
});

test('it moves latest only after the release has its assets', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.latest.needs).toContain('publish');
});

test.each([['tap'], ['npm-pack']] as const)(
  'it gives the %s job the newest release that the latest job looked up',
  (name) => {
    const jobs = parseReleaseWorkflow(
      readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
    );

    expect(jobs[name].needs).toContain('latest');
  },
);

// The traces run the Tag latest step of two overlapping release runs one after the other, as the
// latest-tag group runs them, with a stub gh that answers the newest release from a file the test
// moves on as release-please would, and a stub docker that records the move.
test('it leaves latest on the newer release when the older run holds the lock after the newer run', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).latest.steps.find((candidate) => candidate.id === 'latest')?.run;

  const newest = join(ctx.dir, 'newest');
  const gh = createStubBin(ctx.dir, 'gh', `cat '${newest}'`);

  createStubBin(ctx.dir, 'docker', 'exit 0');
  invariant(step);
  writeFileSync(newest, 'v1.0.4\n');

  const runs = [
    { TAG: 'v1.0.4', VERSION: '1.0.4' },
    { TAG: 'v1.0.3', VERSION: '1.0.3' },
  ].map(
    (run) =>
      Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
        env: {
          ...run,
          PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
          IMAGE: 'ghcr.io/zgeoff/imp-host',
          GITHUB_OUTPUT: ctx.outputs,
          GITHUB_REPOSITORY: 'zgeoff/impz',
        },
      }).exitCode,
  );

  expect(runs).toStrictEqual([0, 0]);

  expect(readFileSync(gh.calls, 'utf8')).toBe(
    [
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'docker buildx imagetools create -t ghcr.io/zgeoff/imp-host:latest ghcr.io/zgeoff/imp-host:1.0.4',
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      '',
    ].join('\n'),
  );
});

test('it leaves latest on the newer release when the older run holds the lock first, after the newer release is out', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).latest.steps.find((candidate) => candidate.id === 'latest')?.run;

  const newest = join(ctx.dir, 'newest');
  const gh = createStubBin(ctx.dir, 'gh', `cat '${newest}'`);

  createStubBin(ctx.dir, 'docker', 'exit 0');
  invariant(step);
  writeFileSync(newest, 'v1.0.4\n');

  const runs = [
    { TAG: 'v1.0.3', VERSION: '1.0.3' },
    { TAG: 'v1.0.4', VERSION: '1.0.4' },
  ].map(
    (run) =>
      Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
        env: {
          ...run,
          PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
          IMAGE: 'ghcr.io/zgeoff/imp-host',
          GITHUB_OUTPUT: ctx.outputs,
          GITHUB_REPOSITORY: 'zgeoff/impz',
        },
      }).exitCode,
  );

  expect(runs).toStrictEqual([0, 0]);

  expect(readFileSync(gh.calls, 'utf8')).toBe(
    [
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'docker buildx imagetools create -t ghcr.io/zgeoff/imp-host:latest ghcr.io/zgeoff/imp-host:1.0.4',
      '',
    ].join('\n'),
  );
});

test('it moves latest forward when the older run holds the lock before the newer release is out', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).latest.steps.find((candidate) => candidate.id === 'latest')?.run;

  const newest = join(ctx.dir, 'newest');
  const gh = createStubBin(ctx.dir, 'gh', `cat '${newest}'`);

  const env = {
    PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
    IMAGE: 'ghcr.io/zgeoff/imp-host',
    GITHUB_OUTPUT: ctx.outputs,
    GITHUB_REPOSITORY: 'zgeoff/impz',
  };

  createStubBin(ctx.dir, 'docker', 'exit 0');
  invariant(step);
  writeFileSync(newest, 'v1.0.3\n');

  const older = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    env: { ...env, TAG: 'v1.0.3', VERSION: '1.0.3' },
  });

  writeFileSync(newest, 'v1.0.4\n');

  const newer = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    env: { ...env, TAG: 'v1.0.4', VERSION: '1.0.4' },
  });

  expect(older.exitCode).toBe(0);
  expect(newer.exitCode).toBe(0);

  expect(readFileSync(gh.calls, 'utf8')).toBe(
    [
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'docker buildx imagetools create -t ghcr.io/zgeoff/imp-host:latest ghcr.io/zgeoff/imp-host:1.0.3',
      'gh release view --repo zgeoff/impz --json tagName --jq .tagName',
      'docker buildx imagetools create -t ghcr.io/zgeoff/imp-host:latest ghcr.io/zgeoff/imp-host:1.0.4',
      '',
    ].join('\n'),
  );
});

test('it tells the formula and npm that a release behind the newest is not the newest', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).latest.steps.find((candidate) => candidate.id === 'latest')?.run;

  const gh = createStubBin(ctx.dir, 'gh', 'echo v1.0.4');

  createStubBin(ctx.dir, 'docker', 'exit 0');
  invariant(step);

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    env: {
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      TAG: 'v1.0.3',
      VERSION: '1.0.3',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('newest_tag=v1.0.4\nis_newest=false\n');

  expect(result.stdout.toString()).toBe(
    'v1.0.3 is not the newest release (v1.0.4); latest stays\n',
  );
});

test('it tells the formula and npm that the newest release is the newest', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).latest.steps.find((candidate) => candidate.id === 'latest')?.run;

  const gh = createStubBin(ctx.dir, 'gh', 'echo v1.0.4');

  createStubBin(ctx.dir, 'docker', 'exit 0');
  invariant(step);

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    env: {
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      TAG: 'v1.0.4',
      VERSION: '1.0.4',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('newest_tag=v1.0.4\nis_newest=true\n');
});

test('it fails the job, moving nothing, when the newest release cannot be read', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).latest.steps.find((candidate) => candidate.id === 'latest')?.run;

  const gh = createStubBin(ctx.dir, 'gh', 'echo "HTTP 502" >&2; exit 1');

  createStubBin(ctx.dir, 'docker', 'exit 0');
  invariant(step);

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    env: {
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      IMAGE: 'ghcr.io/zgeoff/imp-host',
      TAG: 'v1.0.4',
      VERSION: '1.0.4',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_REPOSITORY: 'zgeoff/impz',
    },
  });

  expect(result.exitCode).toBe(1);

  expect(readFileSync(gh.calls, 'utf8')).toBe(
    'gh release view --repo zgeoff/impz --json tagName --jq .tagName\n',
  );
});

test('it leaves the formula of a tag from before the rename, class Imp, out of the tap', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).tap.steps.find((candidate) => candidate.name === 'Update the formula')?.run;

  invariant(step);

  const gitEnv = { ...createGitFreeEnv(process.env), HOME: ctx.dir };

  const runGit = (...args: readonly string[]) =>
    Bun.spawnSync(['git', ...args], { env: gitEnv }).stdout.toString();

  // the tap as it is: impz's formula only
  mkdirSync(join(ctx.dir, 'seed', 'Formula'), { recursive: true });

  writeFileSync(
    join(ctx.dir, 'seed', 'Formula', 'impz.rb'),
    'class Impz < Formula\n  version "2.0.0"\nend\n',
  );

  runGit('-C', join(ctx.dir, 'seed'), 'init', '-q', '-b', 'main');
  runGit('-C', join(ctx.dir, 'seed'), 'add', '.');

  runGit(
    '-C',
    join(ctx.dir, 'seed'),
    '-c',
    'user.name=seed',
    '-c',
    'user.email=seed@example.test',
    'commit',
    '-q',
    '-m',
    'seed',
  );

  runGit('clone', '-q', '--bare', join(ctx.dir, 'seed'), join(ctx.dir, 'tap.git'));

  // the generator a tag from before the rename checks out, at its old path
  mkdirSync(join(ctx.tree, 'scripts'), { recursive: true });

  writeFileSync(
    join(ctx.tree, 'scripts', 'build-formula.sh'),
    '#!/bin/sh\nprintf \'class Imp < Formula\\n  version "%s"\\nend\\n\' "$1"\n',
    { mode: 0o755 },
  );

  mkdirSync(join(ctx.tree, 'dist'));
  writeFileSync(join(ctx.tree, 'dist', 'SHA256SUMS'), '');
  rmSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });

  const gh = createStubBin(
    ctx.dir,
    'gh',
    '[ "$1 $2" = "repo clone" ] && exec git clone -q "$STUB_TAP_REMOTE" "$4"\nexit 0',
  );

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    cwd: ctx.tree,
    env: {
      ...gitEnv,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      GH_TOKEN: 'tap-token',
      TAP: 'zgeoff/homebrew-tap',
      VERSION: '1.6.0',
      STUB_TAP_REMOTE: join(ctx.dir, 'tap.git'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(runGit('--git-dir', join(ctx.dir, 'tap.git'), 'log', '-1', '--format=%s', 'main')).toBe(
    'seed\n',
  );

  expect(
    runGit('--git-dir', join(ctx.dir, 'tap.git'), 'ls-tree', '--name-only', 'main', 'Formula/'),
  ).toBe('Formula/impz.rb\n');

  expect(runGit('--git-dir', join(ctx.dir, 'tap.git'), 'show', 'main:Formula/impz.rb')).toBe(
    'class Impz < Formula\n  version "2.0.0"\nend\n',
  );
});

test('it writes the formula of a tag after the rename to impz.rb with the generator in scripts/release', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).tap.steps.find((candidate) => candidate.name === 'Update the formula')?.run;

  invariant(step);

  const gitEnv = { ...createGitFreeEnv(process.env), HOME: ctx.dir };

  const runGit = (...args: readonly string[]) =>
    Bun.spawnSync(['git', ...args], { env: gitEnv }).stdout.toString();

  // the tap as it is: impz's formula only
  mkdirSync(join(ctx.dir, 'seed', 'Formula'), { recursive: true });

  writeFileSync(
    join(ctx.dir, 'seed', 'Formula', 'impz.rb'),
    'class Impz < Formula\n  version "2.0.0"\nend\n',
  );

  runGit('-C', join(ctx.dir, 'seed'), 'init', '-q', '-b', 'main');
  runGit('-C', join(ctx.dir, 'seed'), 'add', '.');

  runGit(
    '-C',
    join(ctx.dir, 'seed'),
    '-c',
    'user.name=seed',
    '-c',
    'user.email=seed@example.test',
    'commit',
    '-q',
    '-m',
    'seed',
  );

  runGit('clone', '-q', '--bare', join(ctx.dir, 'seed'), join(ctx.dir, 'tap.git'));

  writeFileSync(
    join(ctx.tree, 'scripts', 'release', 'build-formula.sh'),
    readFileSync(new URL('../../scripts/release/build-formula.sh', import.meta.url)),
    { mode: 0o755 },
  );

  mkdirSync(join(ctx.tree, 'dist'));

  writeFileSync(
    join(ctx.tree, 'dist', 'SHA256SUMS'),
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
      .map((platform) => `${'1'.repeat(64)}  impz-${platform}\n`)
      .join(''),
  );

  const gh = createStubBin(
    ctx.dir,
    'gh',
    '[ "$1 $2" = "repo clone" ] && exec git clone -q "$STUB_TAP_REMOTE" "$4"\nexit 0',
  );

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    cwd: ctx.tree,
    env: {
      ...gitEnv,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      GH_TOKEN: 'tap-token',
      TAP: 'zgeoff/homebrew-tap',
      VERSION: '2.0.1',
      STUB_TAP_REMOTE: join(ctx.dir, 'tap.git'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(runGit('--git-dir', join(ctx.dir, 'tap.git'), 'log', '-1', '--format=%s', 'main')).toBe(
    'impz 2.0.1\n',
  );

  expect(runGit('--git-dir', join(ctx.dir, 'tap.git'), 'show', 'main:Formula/impz.rb')).toStartWith(
    'class Impz < Formula\n',
  );

  expect(
    runGit('--git-dir', join(ctx.dir, 'tap.git'), 'ls-tree', '--name-only', 'main', 'Formula/'),
  ).toBe('Formula/impz.rb\n');
});

test('it fails the job, moving no formula, when the generator prints no formula class', () => {
  const ctx = setupTest();

  const step = parseReleaseWorkflow(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).tap.steps.find((candidate) => candidate.name === 'Update the formula')?.run;

  invariant(step);

  writeFileSync(
    join(ctx.tree, 'scripts', 'release', 'build-formula.sh'),
    '#!/bin/sh\necho oops\n',
    {
      mode: 0o755,
    },
  );

  mkdirSync(join(ctx.tree, 'dist'));
  writeFileSync(join(ctx.tree, 'dist', 'SHA256SUMS'), '');

  const gh = createStubBin(ctx.dir, 'gh', '[ "$1 $2" = "repo clone" ] && mkdir -p "$4"\nexit 0');

  const result = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', step], {
    cwd: ctx.tree,
    env: {
      ...createGitFreeEnv(process.env),
      HOME: ctx.dir,
      PATH: `${gh.bin}:${process.env['PATH'] ?? ''}`,
      GH_TOKEN: 'tap-token',
      TAP: 'zgeoff/homebrew-tap',
      VERSION: '2.0.1',
    },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'scripts/release/build-formula.sh printed no formula class\n',
  });

  expect(readdirSync(join(ctx.tree, 'tap', 'Formula'))).toStrictEqual([]);
});
