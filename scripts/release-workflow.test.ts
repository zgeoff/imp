import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as z from 'zod';

// The base job publishes imp-base, which other images pin by digest, so a
// published tag must never move (RELEASING.md).
const StepSchema = z.looseObject({
  name: z.string(),
  id: z.string().optional(),
  if: z.string().optional(),
  run: z.string().optional(),
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

function findStep(needle: string, unless?: string): number {
  return base.steps.findIndex(
    (step) =>
      step.run !== undefined &&
      step.run.includes(needle) &&
      (unless === undefined || !step.run.includes(unless)),
  );
}

test('the base job runs after the smoke checks, with the image job permissions', () => {
  expect(base.needs).toContain('smoke');
  expect(base.permissions).toEqual(jobs.image.permissions);
});

test('the base job checks for an existing tag before it builds or pushes', () => {
  const check = findStep('imagetools inspect', 'docker push');
  const build = findStep('docker buildx build');
  const push = findStep('docker push');

  expect(check).toBeGreaterThanOrEqual(0);
  expect(check).toBeLessThan(build);
  expect(build).toBeLessThan(push);
  expect(base.steps[check]?.id).toBe('tag');
});

test('an existing tag skips every step after the check, so it never moves', () => {
  const check = findStep('imagetools inspect', 'docker push');
  const after = base.steps.slice(check + 1);

  expect(base.steps[check]?.run).toContain('::notice::');

  expect(after.map((step) => step.name)).toEqual([
    'Build image',
    'Check image',
    'Push image',
    'Attest image',
  ]);

  for (const step of after) {
    expect(step.if).toBe("steps.tag.outputs.exists == 'false'");
  }
});

test('the base job builds linux/amd64 only and never moves latest', () => {
  const build = base.steps[findStep('docker buildx build')];

  expect(build?.run).toContain('--platform linux/amd64');
  expect(JSON.stringify(base)).not.toContain(':latest');
});

test('publish does not wait for the base job, so a base failure never holds up a release', () => {
  expect(jobs.publish.needs).not.toContain('base');
});
