// `bun run render:deploy`: deploy/imp-host.args.json into deploy/imp-host.service, bootstrap.sh's
// copy and deploy/compose.yaml (the NixOS module reads the JSON itself). `--check` writes nothing
// and fails on a difference, as scripts/render-imp-host.test.ts does under `bun test`.
import { readFileSync, writeFileSync } from 'node:fs';
import * as z from 'zod';

const ARGS_FILE = 'deploy/imp-host.args.json';
const UNIT_FILE = 'deploy/imp-host.service';
const BOOTSTRAP_FILE = 'deploy/bootstrap.sh';
const COMPOSE_FILE = 'deploy/compose.yaml';

// unquoted in the unit and in Nix's escapeShellArgs alike
const PLAIN_WORD = /^[\w@%+=:,./-]+$/u;

// `$IMP_PUBLIC_PORTS`: zero or more words from the env file (systemd splits an unbraced $NAME)
const ENV_WORDS = /^\$[A-Z][A-Z0-9_]*$/u;

// from `ExecStart=` through the image, the unit's last word
const EXEC_START = /^ExecStart=\/usr\/bin\/docker run (?:.*\\\n)*\s*\$\{IMP_HOST_IMAGE\}$/mu;

// the ExecStartPre that writes PROBED_FILE, not the one that makes the IPv6 network
const PROBE = /^ExecStartPre=\/bin\/sh -c 'a=; .*'$/mu;
const PROBED_FILE = '/run/imp-host/probed.env';
const EMBED_HEAD = "unit_imp_host() {\n  cat <<'EOF'\n";
const EMBED_TAIL = '\nEOF\n}\n';
const COMPOSE_HEAD = '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n';
const COMPOSE_TAIL = '    # end of privileges\n';

type Lines = readonly (readonly string[])[];

// args passed only where path exists on the host
interface Probed {
  readonly path: string;
  readonly args: readonly string[];
}

export interface HostArgs {
  // replaces --privileged (docs/architecture/host-contract.md#privileges)
  readonly privileges: Lines;

  readonly probed: readonly Probed[];
  readonly lines: Lines;
}

const WordSchema = z.string().regex(PLAIN_WORD, { error: 'is not a plain word' });

// lines may also hold an env file's words; privileges and probed args may not
const LineWordSchema = z.string().refine((word) => PLAIN_WORD.test(word) || ENV_WORDS.test(word), {
  error: 'is not a plain word or $NAME',
});

const PrivilegeLinesSchema = z
  .array(z.array(WordSchema).nonempty({ error: 'must be non-empty' }))
  .nonempty({ error: 'must be non-empty' });

const LinesSchema = z
  .array(z.array(LineWordSchema).nonempty({ error: 'must be non-empty' }))
  .nonempty({ error: 'must be non-empty' });

const ProbedSchema = z.object({ path: WordSchema, args: z.array(WordSchema).nonempty() });

const HostArgsSchema = z.object({
  privileges: PrivilegeLinesSchema,
  probed: z.array(ProbedSchema),
  lines: LinesSchema,
});

export function readHostArgs(json: string): HostArgs {
  const parsed = HostArgsSchema.safeParse(JSON.parse(json));

  if (!parsed.success) {
    throw new Error(`${ARGS_FILE}: ${z.prettifyError(parsed.error)}`);
  }

  return parsed.data;
}

// the first line (the name), the privileges, the rest, then the host devices the probe found
export function renderExecStart(args: HostArgs): string {
  const [first = [], ...rest] = args.lines;
  const tail = [...args.privileges, ...rest].map((line) => `  ${line.join(' ')} \\`);

  return [
    `ExecStart=/usr/bin/docker run ${first.join(' ')} \\`,
    ...tail,
    '  $IMP_HOST_PROBED \\',
    `  \${IMP_HOST_IMAGE}`,
  ].join('\n');
}

// IMP_HOST_PROBED: the probed args whose path this host has. Unbraced in ExecStart, it splits
// into words, and none when empty.
export function renderProbe(probed: readonly Probed[]): string {
  const tests = probed.map((entry) => `[ -e ${entry.path} ] && a="$$a ${entry.args.join(' ')}"; `);

  return `ExecStartPre=/bin/sh -c 'a=; ${tests.join('')}echo "IMP_HOST_PROBED=$$a" >${PROBED_FILE}'`;
}

export function renderUnit(unit: string, args: HostArgs): string {
  if (!EXEC_START.test(unit)) {
    throw new Error(`${UNIT_FILE}: no docker run ExecStart that ends in \${IMP_HOST_IMAGE}`);
  }

  if (!PROBE.test(unit)) {
    throw new Error(`${UNIT_FILE}: no ExecStartPre=/bin/sh -c '...' for the probed args`);
  }

  // functions: a replacement string would read $$ as one $
  return unit
    .replace(EXEC_START, () => renderExecStart(args))
    .replace(PROBE, () => renderProbe(args.probed));
}

// the compose keys of the docker run flags that privileges uses
const COMPOSE_SCALARS: Readonly<Record<string, string>> = {
  '--init': 'init: true',
  '--cgroupns=private': 'cgroup: private',
};

const COMPOSE_LISTS: Readonly<Record<string, string>> = {
  '--cap-drop': 'cap_drop',
  '--cap-add': 'cap_add',
  '--security-opt': 'security_opt',
  '--device': 'devices',
  '--sysctl': 'sysctls',
};

function renderComposeKeys(privileges: Lines): string[] {
  const scalars: string[] = [];

  const lists = new Map<string, string[]>();

  const words = privileges.flat();

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const scalar = COMPOSE_SCALARS[word];
    const list = COMPOSE_LISTS[word];

    if (scalar !== undefined) {
      scalars.push(`    ${scalar}`);
    } else if (list === undefined) {
      throw new Error(`${ARGS_FILE}: no compose key for the privilege ${word}`);
    } else {
      index += 1;

      const values = lists.get(list) ?? [];

      values.push(`      - ${words[index] ?? ''}`);
      lists.set(list, values);
    }
  }

  const lines = scalars;

  for (const [key, values] of lists) {
    lines.push(`    ${key}:`, ...values);
  }

  return lines;
}

// Compose cannot probe: the IPv6 sysctls go in as they are, and /dev/zfs comes from
// deploy/compose.zfs.yaml.
function buildComposeProbed(probed: readonly Probed[]): Lines {
  return probed.filter((entry) => entry.args[0] !== '--device').map((entry) => entry.args);
}

export function renderCompose(compose: string, privileges: Lines): string {
  const start = compose.indexOf(COMPOSE_HEAD);
  const end = compose.indexOf(COMPOSE_TAIL, start);

  if (start === -1 || end === -1) {
    throw new Error(`${COMPOSE_FILE}: no privileges block`);
  }

  return (
    compose.slice(0, start + COMPOSE_HEAD.length) +
    [...renderComposeKeys(privileges), ''].join('\n') +
    compose.slice(end)
  );
}

export function renderBootstrap(bootstrap: string, unit: string): string {
  const start = bootstrap.indexOf(EMBED_HEAD);
  const end = bootstrap.indexOf(EMBED_TAIL, start);

  if (start === -1 || end === -1) {
    throw new Error(`${BOOTSTRAP_FILE}: no unit_imp_host heredoc`);
  }

  return (
    bootstrap.slice(0, start + EMBED_HEAD.length) + unit.replace(/\n+$/u, '') + bootstrap.slice(end)
  );
}

export interface Rendered {
  readonly unit: string;
  readonly bootstrap: string;
  readonly compose: string;
}

export function render(argsJson: string, current: Rendered): Rendered {
  const args = readHostArgs(argsJson);
  const unit = renderUnit(current.unit, args);

  return {
    unit,
    bootstrap: renderBootstrap(current.bootstrap, unit),
    compose: renderCompose(current.compose, [
      ...args.privileges,
      ...buildComposeProbed(args.probed),
    ]),
  };
}

const FILES = { unit: UNIT_FILE, bootstrap: BOOTSTRAP_FILE, compose: COMPOSE_FILE } as const;
const KEYS = ['unit', 'bootstrap', 'compose'] as const;

function main(): void {
  const current: Rendered = {
    unit: readFileSync(UNIT_FILE, 'utf8'),
    bootstrap: readFileSync(BOOTSTRAP_FILE, 'utf8'),
    compose: readFileSync(COMPOSE_FILE, 'utf8'),
  };

  const next = render(readFileSync(ARGS_FILE, 'utf8'), current);
  const stale = KEYS.filter((key) => next[key] !== current[key]).map((key) => FILES[key]);

  if (process.argv.includes('--check')) {
    if (stale.length > 0) {
      console.error(
        `render-imp-host: ${stale.join(', ')} differ from ${ARGS_FILE}; run bun run render:deploy`,
      );

      process.exit(1);
    }

    console.log(`render-imp-host: ${Object.values(FILES).join(', ')} match ${ARGS_FILE}`);

    return;
  }

  for (const key of KEYS) {
    writeFileSync(FILES[key], next[key]);
  }

  console.log(`render-imp-host: wrote ${stale.length > 0 ? stale.join(', ') : 'nothing new'}`);
}

if (import.meta.main) {
  main();
}
