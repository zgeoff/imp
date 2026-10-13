import { parseArgs as parseArgv } from 'node:util';
import { FAST_GROUPS, SUITES, SUITE_SETS } from './suites';

export interface HarnessArgs {
  // suite names, in run order
  readonly suites: readonly string[];

  // the full definition of done: tailscale must pass, not skip
  readonly acceptance: boolean;
  readonly clean: boolean;
  readonly keep: boolean;
  readonly reuse: boolean;
  readonly help: boolean;
}

// --group N: one of the fast set's CI groups, as its runner runs it
function resolveGroup(group: string): readonly string[] {
  const suites = /^[1-9]\d*$/.test(group) ? FAST_GROUPS[Number(group) - 1] : undefined;

  if (suites === undefined) {
    throw new Error(`--group takes 1 to ${String(FAST_GROUPS.length)}, not ${group}`);
  }

  return suites;
}

function resolveSuites(only: string): readonly string[] {
  const wanted = new Set<string>();

  for (const item of only.split(',')) {
    const name = item.trim();

    if (name === '') {
      continue;
    }

    const set = SUITE_SETS[name];

    if (set !== undefined) {
      for (const member of set) {
        wanted.add(member);
      }
    } else if (SUITES.some((suite) => suite.name === name)) {
      wanted.add(name);
    } else {
      throw new Error(`unknown suite or set: ${name}`);
    }
  }

  if (wanted.size === 0) {
    throw new Error('--only names no suite');
  }

  return SUITES.map((suite) => suite.name).filter((name) => wanted.has(name));
}

// node's own parser reports an unknown flag, a stray argument and a flag
// missing its value
export function parseArgs(argv: readonly string[]): HarnessArgs {
  const parsed = parseArgv({
    args: [...argv],
    options: {
      only: { type: 'string' },
      group: { type: 'string' },
      clean: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      reuse: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const only = parsed.values.only ?? null;
  const group = parsed.values.group ?? null;

  const flags = {
    clean: parsed.values.clean,
    keep: parsed.values.keep,
    reuse: parsed.values.reuse,
    help: parsed.values.help,
  };

  if (flags.clean && flags.reuse) {
    throw new Error('--clean and --reuse contradict each other');
  }

  if (group !== null && only !== null) {
    throw new Error('--group and --only contradict each other');
  }

  if (group !== null) {
    return { suites: resolveGroup(group), acceptance: false, ...flags };
  }

  const acceptance = only === null || only.split(',').some((item) => item.trim() === 'acceptance');

  return {
    suites: only === null ? (SUITE_SETS['acceptance'] ?? []) : resolveSuites(only),
    acceptance,
    ...flags,
  };
}
