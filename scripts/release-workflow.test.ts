import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invariant } from '@imp/test-utils/invariant';
import { buildStubRegistryDocker } from './test-utils/build-stub-registry-docker';
import { createStubBin } from './test-utils/create-stub-bin';
import { parseReleaseWorkflow } from './test-utils/parse-release-workflow';

// The base job publishes imp-base, which other images pin by digest, so a published tag must
// never move (RELEASING.md). The Plan step's tests run its shell as Actions does (bash -eo
// pipefail), with a stub docker and gh on PATH and a checked-out tree in a scratch directory.
function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-release-workflow-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // the checked-out tree the Plan step reads, and the file Actions collects its outputs from
  mkdirSync(join(dir, 'tree', 'images', 'base'), { recursive: true });
  mkdirSync(join(dir, 'tree', 'host'));
  writeFileSync(join(dir, 'outputs'), '');

  return {
    dir,
    tree: join(dir, 'tree'),
    outputs: join(dir, 'outputs'),
  };
}

test('it runs the base job after the smoke checks, with the image job permissions', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.base.needs).toContain('smoke');
  expect(jobs.base.permissions).toStrictEqual(jobs.image.permissions);
});

test('it checks out the tag being built in the base job', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  const checkout = jobs.base.steps.find(
    (step) => step.uses?.startsWith('actions/checkout@') === true,
  );

  // an Actions expression, not a template placeholder
  expect(checkout?.with).toContainEntry(['ref', `\${{ inputs.tag || github.sha }}`]);
});

test('it labels the base image with the commit it builds', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  const build = jobs.base.steps.find((step) => step.run?.includes('docker buildx build') === true);

  expect(build?.run).toInclude('git rev-parse HEAD');
});

test('it builds the base image for linux/amd64 only', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  const build = jobs.base.steps.find((step) => step.run?.includes('docker buildx build') === true);
  const platforms = [...(build?.run ?? '').matchAll(/--platform[ =](?<list>\S+)/gv)];

  expect(platforms.map((match) => match.groups?.['list'])).toStrictEqual(['linux/amd64']);
});

test('it plans before any build, and builds, checks, pushes and attests only on push', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
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
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
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
      GITHUB_REPOSITORY: 'zgeoff/imp',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=push\n');
});

test('it leaves an attested existing tag alone, with a notice', () => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: digest }),
  );

  const gh = createStubBin(ctx.dir, 'gh', 'exit 0');

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
      GITHUB_REPOSITORY: 'zgeoff/imp',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('action=skip\n');

  expect(result.stdout.toString()).toInclude(
    `::notice::ghcr.io/zgeoff/imp-base:1.2.3 exists already at ${digest}`,
  );

  expect(readFileSync(gh.calls, 'utf8')).toInclude(
    `gh attestation verify oci://ghcr.io/zgeoff/imp-base@${digest} --repo zgeoff/imp\n`,
  );
});

test('it fails the job on an existing tag without an attestation, and plans nothing', () => {
  const ctx = setupTest();

  const plan = parseReleaseWorkflow(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const digest = `sha256:${'0123456789abcdef'.repeat(4)}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: digest }),
  );

  createStubBin(ctx.dir, 'gh', 'exit 1');
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
      GITHUB_REPOSITORY: 'zgeoff/imp',
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
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'found', stdout: 'WARN: something\nsha256:abc' }),
  );

  createStubBin(ctx.dir, 'gh', 'exit 0');
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
      GITHUB_REPOSITORY: 'zgeoff/imp',
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
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ).base.steps.find((step) => step.id === 'plan')?.run;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubRegistryDocker({ kind: 'failed', error }),
  );

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
      GITHUB_REPOSITORY: 'zgeoff/imp',
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
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
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
      GITHUB_REPOSITORY: 'zgeoff/imp',
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
  const text = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

  expect(
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .filter((line) => /BASE_IMAGE|imp-base/v.test(line) && line.includes('latest')),
  ).toStrictEqual([]);
});

test('it never holds a release up on the base job', () => {
  const jobs = parseReleaseWorkflow(
    readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.publish.needs).not.toContain('base');
});
