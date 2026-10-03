import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';

// The base job publishes imp-base, which other images pin by digest, so a
// published tag must never move (RELEASING.md).
const StepSchema = z.looseObject({
  name: z.string(),
  id: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.record(z.string(), z.unknown()).optional(),
});

const JobSchema = z.looseObject({
  needs: z.array(z.string()),
  permissions: z.record(z.string(), z.string()).optional(),
  steps: z.array(StepSchema),
});

const WorkflowSchema = z.looseObject({
  jobs: z.looseObject({ base: JobSchema, image: JobSchema, publish: JobSchema }),
});

const text = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const jobs = WorkflowSchema.parse(Bun.YAML.parse(text)).jobs;
const base = jobs.base;
const IMAGE = 'ghcr.io/zgeoff/imp-base';
const TAG = '1.2.3';
const DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PUSH_ONLY = "steps.plan.outputs.action == 'push'";
const root = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'imp-release-workflow-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function findStep(needle: string): number {
  return base.steps.findIndex((step) => step.run !== undefined && step.run.includes(needle));
}

const planIndex = base.steps.findIndex((step) => step.id === 'plan');
const planRun = base.steps[planIndex]?.run ?? '';

// what the fake registry answers for the tag
type Registry = 'found' | 'missing' | 'denied' | 'blob-missing' | 'bad-digest';

const REGISTRY_ANSWERS: Record<Registry, string> = {
  found: `echo ${DIGEST}`,
  missing: 'echo "ERROR: $4: not found" >&2; exit 1',
  denied: 'echo "ERROR: failed to authorize: 403 Forbidden" >&2; exit 1',
  'blob-missing': 'echo "ERROR: blob sha256:abc not found" >&2; exit 1',
  'bad-digest': 'echo "WARN: something"; echo sha256:abc',
};

interface Run {
  readonly registry: Registry;
  readonly attested?: boolean;

  // the checked-out tree is a release from before imp-base: no check script
  readonly oldTree?: boolean;
}

interface Result {
  readonly exitCode: number;
  readonly stdout: string;
  readonly outputs: Record<string, string>;
  readonly dockerCalls: string;
}

function writeTool(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// Runs the Plan step's shell as Actions does (bash -eo pipefail), with a fake
// docker and gh on PATH and a checked-out tree in a scratch directory.
function runPlan(run: Run): Result {
  const dir = mkdtempSync(join(root, 'run-'));
  const bin = join(dir, 'bin');
  const tree = join(dir, 'tree');

  mkdirSync(bin);
  mkdirSync(join(tree, 'images/base'), { recursive: true });
  mkdirSync(join(tree, 'host'));

  writeTool(
    join(bin, 'docker'),
    `echo "$*" >> ${dir}/docker-calls\n${REGISTRY_ANSWERS[run.registry]}`,
  );

  writeTool(join(bin, 'gh'), `exit ${run.attested === true ? 0 : 1}`);
  writeFileSync(join(dir, 'docker-calls'), '');
  writeFileSync(join(dir, 'outputs'), '');

  if (run.oldTree === true) {
    writeFileSync(join(tree, 'images/base/Dockerfile'), 'FROM ubuntu:24.04\n');
  } else {
    writeFileSync(join(tree, 'host/check-base-image.sh'), '');

    writeFileSync(
      join(tree, 'images/base/Dockerfile'),
      'FROM ubuntu\nARG DOCKER_CE_VERSION=5:29.8.2-1~ubuntu.24.04~noble\n',
    );
  }

  const proc = Bun.spawnSync(['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', planRun], {
    cwd: tree,
    env: {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: IMAGE,
      PUSH_TAG: TAG,
      GITHUB_OUTPUT: join(dir, 'outputs'),
      GITHUB_REPOSITORY: 'zgeoff/imp',
    },
  });

  const outputs: Record<string, string> = {};

  for (const line of readFileSync(join(dir, 'outputs'), 'utf8').split('\n')) {
    const at = line.indexOf('=');

    if (at > 0) {
      outputs[line.slice(0, at)] = line.slice(at + 1);
    }
  }

  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    outputs,
    dockerCalls: readFileSync(join(dir, 'docker-calls'), 'utf8'),
  };
}

test('the base job runs after the smoke checks, with the image job permissions', () => {
  expect(base.needs).toContain('smoke');
  expect(base.permissions).toEqual(jobs.image.permissions);
});

test('the base job builds the checked-out tag and labels its commit', () => {
  const checkout = base.steps.find((step) => step.uses?.startsWith('actions/checkout@') === true);

  // an Actions expression, not a template placeholder
  expect(checkout?.with?.['ref']).toBe(`\${{ inputs.tag || github.sha }}`);
  expect(base.steps[findStep('docker buildx build')]?.run).toContain('git rev-parse HEAD');
});

test('the plan comes before any build, and only push builds or pushes', () => {
  const after = base.steps.slice(planIndex + 1);

  expect(planIndex).toBeGreaterThanOrEqual(0);

  expect(after.map((step) => step.name)).toEqual([
    'Build image',
    'Check image',
    'Push image',
    'Attest image',
  ]);

  expect(after.map((step) => step.if)).toEqual([PUSH_ONLY, PUSH_ONLY, PUSH_ONLY, PUSH_ONLY]);
});

test('a missing tag is pushed', () => {
  const result = runPlan({ registry: 'missing' });

  expect(result.exitCode).toBe(0);
  expect(result.outputs).toEqual({ action: 'push' });
});

test('an attested existing tag is left alone, with a notice', () => {
  const result = runPlan({ registry: 'found', attested: true });

  expect(result.exitCode).toBe(0);
  expect(result.outputs).toEqual({ action: 'skip' });
  expect(result.stdout).toContain(`::notice::${IMAGE}:${TAG} exists already at ${DIGEST}`);
});

test('an existing tag without an attestation fails the job, and is neither pushed nor attested', () => {
  const result = runPlan({ registry: 'found', attested: false });

  expect(result.exitCode).not.toBe(0);
  expect(result.outputs).toEqual({});

  expect(result.stdout).toContain(
    `::error::${IMAGE}:${TAG} exists at ${DIGEST} with no attestation`,
  );
});

test('an existing tag whose digest is not a sha256 fails the job', () => {
  const result = runPlan({ registry: 'bad-digest', attested: true });

  expect(result.exitCode).not.toBe(0);
  expect(result.outputs).toEqual({});
});

test('any registry error other than the tag not found fails closed', () => {
  for (const registry of ['denied', 'blob-missing'] as const) {
    const result = runPlan({ registry });

    expect(result.exitCode).not.toBe(0);
    expect(result.outputs).toEqual({});
  }
});

test('a release from before imp-base is skipped without asking the registry', () => {
  const result = runPlan({ registry: 'missing', oldTree: true });

  expect(result.exitCode).toBe(0);
  expect(result.outputs).toEqual({ action: 'skip' });
  expect(result.stdout).toContain('::notice::');
  expect(result.dockerCalls).toBe('');
});

test('the base job builds linux/amd64 only', () => {
  expect(base.steps[findStep('docker buildx build')]?.run).toContain('--platform linux/amd64');
});

test('nothing in the workflow tags imp-base latest', () => {
  const code = text.split('\n').filter((line) => !line.trim().startsWith('#'));
  const latest = code.filter((line) => /BASE_IMAGE|imp-base/.test(line) && line.includes('latest'));

  expect(latest).toEqual([]);
});

test('publish does not wait for the base job, so a base failure never holds up a release', () => {
  expect(jobs.publish.needs).not.toContain('base');
});
