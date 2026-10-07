import { expect, test } from 'bun:test';
import { parseReleaseWorkflow } from './parse-release-workflow';

test('it reads the steps and needs of the base, image and publish jobs', () => {
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
  ].join('\n');

  expect(() => parseReleaseWorkflow(yaml)).toThrow();
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
  ].join('\n');

  expect(() => parseReleaseWorkflow(yaml)).toThrow(/"needs"/u);
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
  ].join('\n');

  expect(() => parseReleaseWorkflow(yaml)).toThrow(/"steps"/u);
});
