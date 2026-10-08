import { expect, test } from 'bun:test';
import { parseCiWorkflow } from './parse-ci-workflow';

test('it reads the e2e group matrix, the e2e aggregate and release-please', () => {
  const yaml = [
    'jobs:',
    '  e2e-group:',
    '    env:',
    `      WRITE_CACHE: \${{ github.event_name == 'push' && matrix.group == 1 }}`,
    '    strategy:',
    '      matrix:',
    '        include:',
    '          - { group: 1, browser: true, host-tests: false }',
    '    steps:',
    '      - name: Host networking tests',
    '        if: matrix.host-tests',
    '        run: bun run test:host',
    '      - name: Upload results',
    '        with:',
    `          name: e2e-results-\${{ matrix.group }}`,
    '  e2e:',
    '    if: always()',
    '    needs: [e2e-group]',
    '    steps:',
    '      - env:',
    `          RESULT: \${{ needs.e2e-group.result }}`,
    '        run: test "$RESULT" = success',
    '  release-please:',
    '    needs: [e2e]',
  ].join('\n');

  expect(parseCiWorkflow(yaml)).toStrictEqual({
    'e2e-group': {
      env: { WRITE_CACHE: `\${{ github.event_name == 'push' && matrix.group == 1 }}` },
      strategy: { matrix: { include: [{ group: 1, browser: true, 'host-tests': false }] } },
      steps: [
        { name: 'Host networking tests', if: 'matrix.host-tests', run: 'bun run test:host' },
        { name: 'Upload results', with: { name: `e2e-results-\${{ matrix.group }}` } },
      ],
    },
    e2e: {
      if: 'always()',
      needs: ['e2e-group'],
      steps: [
        { env: { RESULT: `\${{ needs.e2e-group.result }}` }, run: 'test "$RESULT" = success' },
      ],
    },
    'release-please': { needs: ['e2e'] },
  });
});

test('it throws on a workflow without the e2e-group job', () => {
  const yaml = [
    'jobs:',
    '  e2e:',
    '    if: always()',
    '    needs: []',
    '    steps: []',
    '  release-please:',
    '    needs: []',
  ].join('\n');

  expect(() => parseCiWorkflow(yaml)).toThrowWithMessage(Error, /"e2e-group"/u);
});

test('it throws on a matrix row without its host-tests flag', () => {
  const yaml = [
    'jobs:',
    '  e2e-group:',
    '    env: { WRITE_CACHE: "false" }',
    '    strategy:',
    '      matrix:',
    '        include:',
    '          - { group: 1, browser: true }',
    '    steps: []',
    '  e2e:',
    '    if: always()',
    '    needs: []',
    '    steps: []',
    '  release-please:',
    '    needs: []',
  ].join('\n');

  expect(() => parseCiWorkflow(yaml)).toThrowWithMessage(Error, /"host-tests"/u);
});

test('it throws on an e2e aggregate without its if condition', () => {
  const yaml = [
    'jobs:',
    '  e2e-group:',
    '    env: { WRITE_CACHE: "false" }',
    '    strategy:',
    '      matrix:',
    '        include: []',
    '    steps: []',
    '  e2e:',
    '    needs: []',
    '    steps: []',
    '  release-please:',
    '    needs: []',
  ].join('\n');

  expect(() => parseCiWorkflow(yaml)).toThrowWithMessage(Error, /"if"/u);
});

test('it throws on an e2e-group job without its WRITE_CACHE env', () => {
  const yaml = [
    'jobs:',
    '  e2e-group:',
    '    strategy:',
    '      matrix:',
    '        include: []',
    '    steps: []',
    '  e2e:',
    '    if: always()',
    '    needs: []',
    '    steps: []',
    '  release-please:',
    '    needs: []',
  ].join('\n');

  expect(() => parseCiWorkflow(yaml)).toThrowWithMessage(Error, /"env"/u);
});
