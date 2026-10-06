// `bun run render:deploy`: deploy/imp-host.args.json into both units, bootstrap.sh's copies
// and deploy/compose.yaml (the NixOS module reads the JSON itself). `--check` writes nothing
// and fails on a difference, as scripts/render-imp-host.test.ts does under `bun test`.
import { readFileSync, writeFileSync } from 'node:fs';
import * as z from 'zod';

const ARGS_FILE = 'deploy/imp-host.args.json';
const UNIT_FILE = 'deploy/imp-host.service';
const PROXY_UNIT_FILE = 'deploy/imp-docker-proxy.service';
const BOOTSTRAP_FILE = 'deploy/bootstrap.sh';
const COMPOSE_FILE = 'deploy/compose.yaml';

// unquoted in the unit and in Nix's escapeShellArgs alike
const PLAIN_WORD = /^[\w@%+=:,./-]+$/u;

// `$IMP_PUBLIC_PORTS`: zero or more words from the env file (systemd splits an unbraced $NAME)
const ENV_WORDS = /^\$[A-Z][A-Z0-9_]*$/u;

// from `ExecStart=` through the image, the unit's last word
const EXEC_START = /^ExecStart=\/usr\/bin\/docker run (?:.*\\\n)*\s*\$\{IMP_HOST_IMAGE\}$/mu;

// the proxy's: the image, then the proxy's command
const PROXY_EXEC_START =
  /^ExecStart=\/usr\/bin\/docker run (?:.*\\\n)*\s*\$\{IMP_HOST_IMAGE\} \S.*$/mu;

// the ExecStartPre that writes PROBED_FILE, not the one that makes the IPv6 network
const PROBE = /^ExecStartPre=\/bin\/sh -c 'a=; .*'$/mu;
const PROBED_FILE = '/run/imp-host/probed.env';
const EMBED_HEAD = "unit_imp_host() {\n  cat <<'EOF'\n";
const PROXY_EMBED_HEAD = "unit_imp_docker_proxy() {\n  cat <<'EOF'\n";
const EMBED_TAIL = '\nEOF\n}\n';
const COMPOSE_HEAD = '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n';
const COMPOSE_TAIL = '    # end of privileges\n';

const PROXY_COMPOSE_HEAD =
  '    # proxy privileges: from deploy/imp-host.args.json (bun run render:deploy)\n';

const PROXY_COMPOSE_TAIL = '    # end of proxy privileges\n';

type Lines = readonly (readonly string[])[];

// args passed only where path exists on the host
interface Probed {
  readonly path: string;
  readonly args: readonly string[];
}

// the imp-docker-proxy container: the same image, with its own command
interface ProxyArgs {
  readonly privileges: Lines;
  readonly lines: Lines;
  readonly command: readonly string[];
}

export interface HostArgs {
  // replaces --privileged (docs/architecture/host-contract.md#privileges)
  readonly privileges: Lines;

  readonly probed: readonly Probed[];
  readonly lines: Lines;
  readonly proxy: ProxyArgs;
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

const ProxyArgsSchema = z.object({
  privileges: PrivilegeLinesSchema,
  lines: LinesSchema,
  command: z.array(WordSchema).nonempty(),
});

const HostArgsSchema = z.object({
  privileges: PrivilegeLinesSchema,
  probed: z.array(ProbedSchema),
  lines: LinesSchema,
  proxy: ProxyArgsSchema,
});

export function readHostArgs(json: string): HostArgs {
  const parsed = HostArgsSchema.safeParse(JSON.parse(json));

  if (!parsed.success) {
    throw new Error(`${ARGS_FILE}: ${z.prettifyError(parsed.error)}`);
  }

  return parsed.data;
}

// the first line (the name), the privileges, the rest, then the host devices the probe found
export function renderExecStart(args: Omit<HostArgs, 'proxy'>): string {
  const [first = [], ...rest] = args.lines;
  const tail = [...args.privileges, ...rest].map((line) => `  ${line.join(' ')} \\`);

  return [
    `ExecStart=/usr/bin/docker run ${first.join(' ')} \\`,
    ...tail,
    '  $IMP_HOST_PROBED \\',
    `  \${IMP_HOST_IMAGE}`,
  ].join('\n');
}

// the proxy's: the first line (the name), its privileges, the rest, then the image and command
export function renderProxyExecStart(proxy: ProxyArgs): string {
  const [first = [], ...rest] = proxy.lines;
  const tail = [...proxy.privileges, ...rest].map((line) => `  ${line.join(' ')} \\`);

  return [
    `ExecStart=/usr/bin/docker run ${first.join(' ')} \\`,
    ...tail,
    `  \${IMP_HOST_IMAGE} ${proxy.command.join(' ')}`,
  ].join('\n');
}

export function renderProxyUnit(unit: string, proxy: ProxyArgs): string {
  if (!PROXY_EXEC_START.test(unit)) {
    throw new Error(
      `${PROXY_UNIT_FILE}: no docker run ExecStart with \${IMP_HOST_IMAGE} and a command`,
    );
  }

  return unit.replace(PROXY_EXEC_START, () => renderProxyExecStart(proxy));
}

// IMP_HOST_PROBED: the probed args whose path this host has, split into words in ExecStart.
// IMP_HOST_ADDRESSES: the host's own global addresses, which no public imp reaches
// (docs/architecture/networking.md#public), read at each start for a new DHCP lease.
const HOST_ADDRESSES =
  'echo "IMP_HOST_ADDRESSES=$$(ip -o addr show scope global | tr -s " " | cut -d " " -f 4 | paste -sd ,)"';

export function renderProbe(probed: readonly Probed[]): string {
  const tests = probed.map((entry) => `[ -e ${entry.path} ] && a="$$a ${entry.args.join(' ')}"; `);

  return `ExecStartPre=/bin/sh -c 'a=; ${tests.join('')}{ echo "IMP_HOST_PROBED=$$a"; ${HOST_ADDRESSES}; } >${PROBED_FILE}'`;
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
  '--read-only': 'read_only: true',
};

// a flag whose value is a scalar key's
const COMPOSE_VALUES: Readonly<Record<string, string>> = {
  '--network': 'network_mode',
  '--user': 'user',
};

const COMPOSE_LISTS: Readonly<Record<string, string>> = {
  '--cap-drop': 'cap_drop',
  '--cap-add': 'cap_add',
  '--security-opt': 'security_opt',
  '--device': 'devices',
  '--sysctl': 'sysctls',
  '--tmpfs': 'tmpfs',
};

function renderComposeKeys(privileges: Lines): string[] {
  const scalars: string[] = [];

  const lists = new Map<string, string[]>();

  const words = privileges.flat();

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const scalar = COMPOSE_SCALARS[word];
    const valued = COMPOSE_VALUES[word];
    const list = COMPOSE_LISTS[word];

    if (scalar !== undefined) {
      scalars.push(`    ${scalar}`);
    } else if (valued !== undefined) {
      index += 1;

      // quoted as oxfmt writes YAML, so 65534:65534 stays a string
      scalars.push(`    ${valued}: '${words[index] ?? ''}'`);
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

// the block between head and tail, rendered from privileges
function renderComposeBlock(
  compose: string,
  privileges: Lines,
  head: string,
  tail: string,
): string {
  const start = compose.indexOf(head);
  const end = compose.indexOf(tail, start);

  if (start === -1 || end === -1) {
    throw new Error(`${COMPOSE_FILE}: no block from ${JSON.stringify(head.trim())}`);
  }

  return (
    compose.slice(0, start + head.length) +
    [...renderComposeKeys(privileges), ''].join('\n') +
    compose.slice(end)
  );
}

export function renderCompose(compose: string, privileges: Lines): string {
  return renderComposeBlock(compose, privileges, COMPOSE_HEAD, COMPOSE_TAIL);
}

// a unit into its heredoc in bootstrap.sh, the one that starts with head
function renderEmbed(bootstrap: string, head: string, unit: string): string {
  const start = bootstrap.indexOf(head);
  const end = bootstrap.indexOf(EMBED_TAIL, start);

  if (start === -1 || end === -1) {
    throw new Error(`${BOOTSTRAP_FILE}: no heredoc from ${JSON.stringify(head.split('(')[0])}`);
  }

  return bootstrap.slice(0, start + head.length) + unit.replace(/\n+$/u, '') + bootstrap.slice(end);
}

export function renderBootstrap(bootstrap: string, unit: string, proxyUnit: string): string {
  return renderEmbed(renderEmbed(bootstrap, EMBED_HEAD, unit), PROXY_EMBED_HEAD, proxyUnit);
}

export interface Rendered {
  readonly unit: string;
  readonly proxyUnit: string;
  readonly bootstrap: string;
  readonly compose: string;
}

export function render(argsJson: string, current: Rendered): Rendered {
  const args = readHostArgs(argsJson);
  const unit = renderUnit(current.unit, args);
  const proxyUnit = renderProxyUnit(current.proxyUnit, args.proxy);

  const compose = renderCompose(current.compose, [
    ...args.privileges,
    ...buildComposeProbed(args.probed),
  ]);

  return {
    unit,
    proxyUnit,
    bootstrap: renderBootstrap(current.bootstrap, unit, proxyUnit),
    compose: renderComposeBlock(
      compose,
      args.proxy.privileges,
      PROXY_COMPOSE_HEAD,
      PROXY_COMPOSE_TAIL,
    ),
  };
}

const FILES = {
  unit: UNIT_FILE,
  proxyUnit: PROXY_UNIT_FILE,
  bootstrap: BOOTSTRAP_FILE,
  compose: COMPOSE_FILE,
} as const;

const KEYS = ['unit', 'proxyUnit', 'bootstrap', 'compose'] as const;

function main(): void {
  const current: Rendered = {
    unit: readFileSync(UNIT_FILE, 'utf8'),
    proxyUnit: readFileSync(PROXY_UNIT_FILE, 'utf8'),
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
