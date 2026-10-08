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

export function parseArgs(argv: readonly string[]): HarnessArgs {
  const rest = [...argv];
  let only: string | null = null;
  let group: string | null = null;
  let clean = false;
  let keep = false;
  let reuse = false;
  let help = false;

  for (let arg = rest.shift(); arg !== undefined; arg = rest.shift()) {
    switch (arg) {
      case '--clean': {
        clean = true;
        break;
      }
      case '--keep': {
        keep = true;
        break;
      }
      case '--reuse': {
        reuse = true;
        break;
      }
      case '-h':
      case '--help': {
        help = true;
        break;
      }
      case '--only': {
        only = rest.shift() ?? null;

        if (only === null) {
          throw new Error('--only needs a suite list');
        }

        break;
      }
      case '--group': {
        group = rest.shift() ?? null;

        if (group === null) {
          throw new Error('--group needs a group number');
        }

        break;
      }
      default: {
        throw new Error(`unknown argument: ${arg}`);
      }
    }
  }

  if (clean && reuse) {
    throw new Error('--clean and --reuse contradict each other');
  }

  if (group !== null && only !== null) {
    throw new Error('--group and --only contradict each other');
  }

  if (group !== null) {
    return { suites: resolveGroup(group), acceptance: false, clean, keep, reuse, help };
  }

  const acceptance = only === null || only.split(',').some((item) => item.trim() === 'acceptance');

  return {
    suites: only === null ? (SUITE_SETS['acceptance'] ?? []) : resolveSuites(only),
    acceptance,
    clean,
    keep,
    reuse,
    help,
  };
}
