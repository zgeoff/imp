import { isArgsValidationError } from 'gunshi';
import type { ArgsValidationError } from 'gunshi';

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

  switch (error.code) {
    case 'err:arg:invalid-choice': {
      const choices: unknown = values['choiceValues'];
      const list = Array.isArray(choices) ? choices.map(String).join(', ') : '';

      return `${flag} must be one of ${list}`;
    }
    case 'err:arg:invalid-type': {
      return `${flag} must be a whole number, not ${String(values['actual'])}`;
    }
    case 'err:arg:custom-parse': {
      return formatParseFailure(flag, String(values['reason'] ?? error.message));
    }
    case 'err:arg:conflict': {
      const other = readDisplayName(values['conflictDisplayName'], values['conflictName']);

      return `${flag} does not go with ${other}`;
    }
    case 'err:arg:required-positional': {
      return `missing ${flag.toUpperCase()} (see --help)`;
    }
    case 'err:arg:required-option': {
      return `${flag} is required (see --help)`;
    }
    case 'err:arg:missing-value': {
      return flag === '--host'
        ? '--host needs a saved host name (see impz host ls)'
        : `${flag} needs a value`;
    }
    case undefined:
    case 'err:arg:unknown-option':
    case 'err:arg:unexpected-value':
    case 'err:arg:invalid-default': {
      return `${error.message} (see --help)`;
    }
    default: {
      return error.code satisfies never;
    }
  }
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
