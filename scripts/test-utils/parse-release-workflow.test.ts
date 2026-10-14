import { expect, test } from 'bun:test';
import { parseReleaseWorkflow } from './parse-release-workflow';

test('it reads the steps, needs and concurrency of the jobs its tests read', () => {
  const yaml = [
    'jobs:',
    '  base:',
    '    needs: [smoke]',
    '    permissions: { packages: write }',
    '    steps:',
    '      - name: Plan',
    '        id: plan',
    '        run: echo hi',
    '  image:',
    '    needs: [smoke]',
    '    steps: []',
    '  publish:',
    '    needs: [image]',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v5',
    '        with: { ref: main }',
    '  latest:',
    '    needs: [publish]',
    '    concurrency: { group: latest-tag, cancel-in-progress: false, queue: max }',
    '    steps: []',
    '  tap:',
    '    needs: [latest]',
    '    steps: []',
    '  npm-pack:',
    '    needs: [latest]',
    '    steps: []',
  ].join('\n');

  expect(parseReleaseWorkflow(yaml)).toStrictEqual({
    base: {
      needs: ['smoke'],
      permissions: { packages: 'write' },
      steps: [{ name: 'Plan', id: 'plan', run: 'echo hi' }],
    },
    image: { needs: ['smoke'], steps: [] },
    publish: {
      needs: ['image'],
      steps: [{ name: 'Checkout', uses: 'actions/checkout@v5', with: { ref: 'main' } }],
    },
    latest: {
      needs: ['publish'],
      concurrency: { group: 'latest-tag', 'cancel-in-progress': false, queue: 'max' },
      steps: [],
    },
    tap: { needs: ['latest'], steps: [] },
    'npm-pack': { needs: ['latest'], steps: [] },
  });
});

test('it throws on a workflow without the base job', () => {
  const yaml = [
    'jobs:',
    '  image:',
    '    needs: []',
    '    steps: []',
    '  publish:',
    '    needs: []',
    '    steps: []',
    '  latest:',
    '    needs: []',
    '    steps: []',
    '  tap:',
    '    needs: []',
    '    steps: []',
    '  npm-pack:',
    '    needs: []',
    '    steps: []',
  ].join('\n');

  expect(() => parseReleaseWorkflow(yaml)).toThrowWithMessage(Error, /"base"/u);
});

test('it throws on a workflow without the latest job', () => {
  const yaml = [
    'jobs:',
    '  base:',
    '    needs: []',
    '    steps: []',
    '  image:',
    '    needs: []',
    '    steps: []',
    '  publish:',
    '    needs: []',
    '    steps: []',
    '  tap:',
    '    needs: []',
    '    steps: []',
    '  npm-pack:',
    '    needs: []',
    '    steps: []',
  ].join('\n');

  expect(() => parseReleaseWorkflow(yaml)).toThrowWithMessage(Error, /"latest"/u);
});

test('it throws on a job without needs', () => {
  const yaml = [
    'jobs:',
    '  base:',
    '    steps: []',
    '  image:',
    '    needs: []',
    '    steps: []',
    '  publish:',
    '    needs: []',
    '    steps: []',
    '  latest:',
    '    needs: []',
    '    steps: []',
    '  tap:',
    '    needs: []',
    '    steps: []',
    '  npm-pack:',
    '    needs: []',
    '    steps: []',
  ].join('\n');

  expect(() => parseReleaseWorkflow(yaml)).toThrowWithMessage(Error, /"needs"/u);
});

test('it throws on a job without steps', () => {
  const yaml = [
    'jobs:',
    '  base:',
    '    needs: []',
    '  image:',
    '    needs: []',
    '    steps: []',
    '  publish:',
    '    needs: []',
    '    steps: []',
    '  latest:',
    '    needs: []',
    '    steps: []',
    '  tap:',
    '    needs: []',
    '    steps: []',
    '  npm-pack:',
    '    needs: []',
    '    steps: []',
  ].join('\n');

  expect(() => parseReleaseWorkflow(yaml)).toThrowWithMessage(Error, /"steps"/u);
});

test('it throws on a concurrency whose queue is not a string', () => {
  const yaml = [
    'jobs:',
    '  base:',
    '    needs: []',
    '    steps: []',
    '  image:',
    '    needs: []',
    '    steps: []',
    '  publish:',
    '    needs: []',
    '    steps: []',
    '  latest:',
    '    needs: []',
    '    concurrency: { group: latest-tag, queue: [max] }',
    '    steps: []',
    '  tap:',
    '    needs: []',
    '    steps: []',
    '  npm-pack:',
    '    needs: []',
    '    steps: []',
  ].join('\n');

  expect(() => parseReleaseWorkflow(yaml)).toThrowWithMessage(Error, /"queue"/u);
});
