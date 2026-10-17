import { expect, test } from 'bun:test';
import { ArgsValidationError } from 'gunshi';
import { formatValidationError } from './format-validation-error';

test('it names every unknown flag and the command it was for', () => {
  const refusal = new AggregateError(
    [
      new ArgsValidationError('Unknown option: --a', {
        code: 'err:arg:unknown-option',
        values: { rawName: '--a' },
      }),
      new ArgsValidationError('Unknown option: -b', {
        code: 'err:arg:unknown-option',
        values: { rawName: '-b' },
      }),
    ],
    'refused',
  );

  expect(formatValidationError(refusal, 'token new')).toBe(
    'unknown flags --a, -b for token new (see --help)',
  );
});

test.each([
  [
    'a value outside the choices',
    {
      code: 'err:arg:invalid-choice',
      values: { displayName: "'--scope'", name: 'scope', choiceValues: ['read', 'manage'] },
    },
    '--scope must be one of read, manage',
  ],
  [
    'a number above an integer bound',
    {
      code: 'err:arg:custom-parse',
      values: {
        displayName: "'--lines' or '-n'",
        name: 'lines',
        reason: 'Integer must be <= 100000, got 200000',
      },
    },
    '--lines must be at most 100000, not 200000',
  ],
  [
    'a parser’s own refusal',
    {
      code: 'err:arg:custom-parse',
      values: { displayName: "'--require'", name: 'require', reason: '--require takes broker' },
    },
    '--require takes broker',
  ],
  [
    'two flags that do not go together',
    {
      code: 'err:arg:conflict',
      values: {
        displayName: "'--require'",
        name: 'require',
        conflictDisplayName: "'--agent'",
        conflictName: 'agent',
      },
    },
    '--require does not go with --agent',
  ],
  [
    'a missing argument',
    { code: 'err:arg:required-positional', values: { displayName: "'name'", name: 'name' } },
    'missing NAME (see --help)',
  ],
  [
    'a --host with no name',
    { code: 'err:arg:missing-value', values: { displayName: "'--host'", name: 'host' } },
    '--host needs a saved host name (see impz host ls)',
  ],
] as const)('it says what was wrong with %s', (_case, options, expected) => {
  const refusal = new AggregateError([new ArgsValidationError('refused', options)], 'refused');

  expect(formatValidationError(refusal, 'ls')).toBe(expected);
});

test('it gives no line for a refusal with no argument error in it', () => {
  const refusal = new AggregateError([new Error('other')], 'refused');

  expect(formatValidationError(refusal, 'ls')).toBeNull();
});
