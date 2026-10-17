import { isArgsValidationError } from 'gunshi';
import type { ArgsValidationError } from 'gunshi';
import { P, match } from 'ts-pattern';

// The line for a command line gunshi refused, such as an unknown flag or a
// missing argument. `command` is the path of the command it was for.
export function formatValidationError(error: AggregateError, command: string): string | null {
  const errors: readonly unknown[] = error.errors;
  const refused = errors.filter((each) => isArgsValidationError(each));

  const unknown = refused.flatMap((each) =>
    each.code === 'err:arg:unknown-option' ? [String(each.values['rawName'])] : [],
  );

  if (unknown.length > 0) {
    const noun = unknown.length === 1 ? 'flag' : 'flags';
    const where = command === '' ? '' : ` for ${command}`;

    return `unknown ${noun} ${unknown.join(', ')}${where} (see --help)`;
  }

  const [first] = refused;

  return first === undefined ? null : formatArgError(first);
}

function formatArgError(error: Readonly<ArgsValidationError>): string {
  const values = error.values;
  const flag = readDisplayName(values['displayName'], values['name']);

  return match(error.code)
    .with('err:arg:invalid-choice', () => {
      const choices: unknown = values['choiceValues'];
      const list = Array.isArray(choices) ? choices.map(String).join(', ') : '';

      return `${flag} must be one of ${list}`;
    })
    .with(
      'err:arg:invalid-type',
      () => `${flag} must be a whole number, not ${String(values['actual'])}`,
    )
    .with('err:arg:custom-parse', () => {
      const reason = values['reason'];
      const why = typeof reason === 'string' ? reason : error.message;

      return formatParseFailure(flag, why);
    })
    .with('err:arg:conflict', () => {
      const other = readDisplayName(values['conflictDisplayName'], values['conflictName']);

      return `${flag} does not go with ${other}`;
    })
    .with('err:arg:required-positional', () => `missing ${flag.toUpperCase()} (see --help)`)
    .with('err:arg:required-option', () => `${flag} is required (see --help)`)
    .with('err:arg:missing-value', () =>
      flag === '--host'
        ? '--host needs a saved host name (see impz host ls)'
        : `${flag} needs a value`,
    )
    .with(
      P.union(
        undefined,
        'err:arg:unknown-option',
        'err:arg:unexpected-value',
        'err:arg:invalid-default',
      ),
      () => `${error.message} (see --help)`,
    )
    .exhaustive();
}

// gunshi's integer bounds as a sentence, else the parser's own message under
// the flag's name
function formatParseFailure(flag: string, reason: string): string {
  const bound = /^Integer must be (?<op>[<>])= (?<limit>-?\d+), got (?<actual>.+)$/u.exec(reason);

  if (bound?.groups !== undefined) {
    const side = bound.groups['op'] === '<' ? 'at most' : 'at least';

    return `${flag} must be ${side} ${bound.groups['limit'] ?? ''}, not ${bound.groups['actual'] ?? ''}`;
  }

  return reason.startsWith(flag) ? reason : `${flag}: ${reason}`;
}

// the flag as `--name`, or a positional argument by its name
function readDisplayName(displayName: unknown, name: unknown): string {
  const text = typeof displayName === 'string' ? displayName : String(name);

  return text.startsWith("'--") ? `--${String(name)}` : text.replaceAll("'", '');
}
