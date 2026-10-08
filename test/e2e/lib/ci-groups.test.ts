import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseCiWorkflow } from '../../../scripts/test-utils/parse-ci-workflow';
import { FAST_GROUPS, HOST_TESTS_GROUP } from './suites';

test('it runs one e2e-group job for each fast group', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const groups = jobs['e2e-group'].strategy.matrix.include.map((row) => row.group);

  expect(groups).toStrictEqual(FAST_GROUPS.map((_, index) => index + 1));
});

test('it runs the host networking tests only in the host tests group', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const hostGroups = jobs['e2e-group'].strategy.matrix.include
    .filter((row) => row['host-tests'])
    .map((row) => row.group);

  expect(hostGroups).toStrictEqual([HOST_TESTS_GROUP]);
});

test('it gates the host networking step on the matrix flag', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs['e2e-group'].steps.find(
    (candidate) => candidate.name === 'Host networking tests',
  );

  expect(step?.if).toBe('matrix.host-tests');
});

test('it installs the browser only in the group that runs the dashboard suite', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const browserGroups = jobs['e2e-group'].strategy.matrix.include
    .filter((row) => row.browser)
    .map((row) => row.group);

  expect(browserGroups).toStrictEqual([
    FAST_GROUPS.findIndex((group) => group.includes('dashboard')) + 1,
  ]);
});

test('it runs each group with its own --group flag', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs['e2e-group'].steps.find((candidate) => candidate.name === 'End-to-end tests');

  // an Actions expression, not a template placeholder
  expect(step?.run).toBe(`scripts/test-e2e.sh --group \${{ matrix.group }}`);
});

test('it runs the required e2e check whatever the groups did', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.e2e.if).toBe('always()');
});

test('it makes the required e2e check wait on every group', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.e2e.needs).toStrictEqual(['e2e-group']);
});

test('it passes the required e2e check only when the groups succeeded', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const runs = jobs.e2e.steps.map((step) => step.run);

  expect(runs.join('\n')).toInclude('test "$RESULT" = success');
});

test('it keeps release-please waiting on the required e2e check', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs['release-please'].needs).toContain('e2e');
});
