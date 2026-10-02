import { NameSchema } from '@imp/api';

// Which imps one MCP server may touch. It keeps an agent from destroying an
// imp it was not given by mistake; the boundary is the scope of the token it
// runs with (docs/guides/tokens.md), which impd enforces.
export interface ImpGuard {
  readonly isAllowed: (name: string) => boolean;

  // throws a GuardError for an imp outside the guard
  readonly require: (name: string) => void;

  // the name for a create that gave none: the prefix and a random suffix,
  // null to let impd pick one, or a GuardError when nothing fits
  readonly pickNewName: () => string | null;

  // one sentence for the server's instructions and the errors
  readonly summary: string;
}

export interface GuardOptions {
  readonly prefix?: string;
  readonly allow?: readonly string[];
  readonly all?: boolean;
}

export class GuardError extends Error {
  override name = 'GuardError';
}

const SUFFIX_LENGTH = 8;
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// the longest name NameSchema accepts
const MAX_NAME_LENGTH = 31;

// Throws a GuardError for a missing or broken guard: a server for every imp
// must say so with `all`.
export function createImpGuard(options: Readonly<GuardOptions>): ImpGuard {
  const prefix = options.prefix ?? '';

  const allow = new Set(options.allow);

  const all = options.all === true;

  if (all && (prefix !== '' || allow.size > 0)) {
    throw new GuardError('--all allows every imp; leave out --prefix and --allow');
  }

  if (!all && prefix === '' && allow.size === 0) {
    throw new GuardError('choose the imps this server may touch: --prefix, --allow or --all');
  }

  checkPrefix(prefix);

  for (const name of allow) {
    if (!NameSchema.safeParse(name).success) {
      throw new GuardError(`--allow: ${name} is not a valid imp name`);
    }
  }

  const summary = formatGuard(all, prefix, [...allow]);

  const isAllowed = (name: string): boolean =>
    all || allow.has(name) || (prefix !== '' && name.startsWith(prefix));

  return {
    isAllowed,
    require: (name) => {
      if (!isAllowed(name)) {
        throw new GuardError(`imp ${name} is outside this server's guard: ${summary}`);
      }
    },
    pickNewName: () => {
      if (prefix !== '') {
        return `${prefix}${buildSuffix()}`;
      }

      if (all) {
        return null;
      }

      throw new GuardError(`give a name: ${summary}`);
    },
    summary,
  };
}

// a prefix must start a valid name and leave room for the random suffix
function checkPrefix(prefix: string): void {
  if (prefix === '') {
    return;
  }

  const sample = `${prefix}${'a'.repeat(SUFFIX_LENGTH)}`;

  if (sample.length > MAX_NAME_LENGTH || !NameSchema.safeParse(sample).success) {
    throw new GuardError(
      `--prefix ${prefix}: must start with a lowercase letter, hold only lowercase letters, digits and hyphens, and be at most ${String(MAX_NAME_LENGTH - SUFFIX_LENGTH)} characters`,
    );
  }
}

function formatGuard(all: boolean, prefix: string, allow: readonly string[]): string {
  if (all) {
    return 'every imp';
  }

  const parts = [
    ...(prefix === '' ? [] : [`imps named ${prefix}*`]),
    ...(allow.length === 0 ? [] : [`the imps ${allow.join(', ')}`]),
  ];

  return parts.join(' and ');
}

function buildSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH));

  return Array.from(bytes, (byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join('');
}

// The guard for a caller whose token impd already limits to `patterns` (null
// for every imp): impd refuses what is outside them, so this only names a
// create. It picks a name for one `prefix*` pattern; other patterns need one.
export function createPatternGuard(patterns: readonly string[] | null): ImpGuard {
  if (patterns === null) {
    return createImpGuard({ all: true });
  }

  const summary = `imps matching ${patterns.join(', ')}`;
  const prefix = readPrefix(patterns);

  return {
    isAllowed: () => true,
    require: () => {},
    pickNewName: () => {
      if (prefix === null) {
        throw new GuardError(
          `this token may touch only ${summary}, so give the new imp a name that matches`,
        );
      }

      return `${prefix}${buildSuffix()}`;
    },
    summary,
  };
}

// the prefix of a single `prefix*` pattern that leaves room for a suffix
function readPrefix(patterns: readonly string[]): string | null {
  const [pattern] = patterns;

  if (patterns.length !== 1 || pattern === undefined || !pattern.endsWith('*')) {
    return null;
  }

  const prefix = pattern.slice(0, -1);
  const sample = `${prefix}${'a'.repeat(SUFFIX_LENGTH)}`;

  if (prefix.includes('*') || sample.length > MAX_NAME_LENGTH) {
    return null;
  }

  return NameSchema.safeParse(sample).success ? prefix : null;
}
