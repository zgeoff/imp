// `bun run render:deploy`: deploy/imp-host.args.json into the units, compose.yaml and host-env.sh,
// and deploy/bootstrap.sh from its parts and the files it installs. `--check` writes nothing and
// fails on a difference, as scripts/render/render-imp-host.test.ts does under `bun test`.
import { readFileSync, writeFileSync } from 'node:fs';
import { Document, Scalar, YAMLMap } from 'yaml';
import * as z from 'zod';

const ARGS_FILE = 'deploy/imp-host.args.json';
const UNIT_FILE = 'deploy/imp-host.service';
const PROXY_UNIT_FILE = 'deploy/imp-docker-proxy.service';
const BOOTSTRAP_FILE = 'deploy/bootstrap.sh';
const COMPOSE_FILE = 'deploy/compose.yaml';
const ENV_EXAMPLE_FILE = 'deploy/imp-host.env.example';
const HOST_ENV_FILE = 'deploy/lib/host-env.sh';

// bootstrap.sh's parts, in its order; the deploy files go in after UNITS_PART
export const BOOTSTRAP_PARTS = [
  'deploy/bootstrap/start.sh',
  'deploy/lib/host-env.sh',
  'deploy/bootstrap/checks.sh',
  'deploy/bootstrap/packages.sh',
  'deploy/bootstrap/storage.sh',
  'deploy/bootstrap/kernel.sh',
  'deploy/bootstrap/network.sh',
  'deploy/bootstrap/units.sh',
  'deploy/bootstrap/imp.sh',
  'deploy/bootstrap/main.sh',
] as const;

const UNITS_PART = 'deploy/bootstrap/units.sh';

// unquoted in the unit and in Nix's escapeShellArgs alike
const PLAIN_WORD = /^[\w@%+=:,./-]+$/u;

// `$IMP_PUBLIC_PORTS`: zero or more words from the env file (systemd splits an unbraced $NAME)
const ENV_WORDS = /^\$[A-Z][A-Z0-9_]*$/u;

// from `ExecStart=` through the image, the unit's last word
const EXEC_START = /^ExecStart=\/usr\/bin\/docker run (?:.*\\\n)*\s*\$\{IMP_HOST_IMAGE\}$/mu;

// the proxy's: the image, then the proxy's command
const PROXY_EXEC_START =
  /^ExecStart=\/usr\/bin\/docker run (?:.*\\\n)*\s*\$\{IMP_HOST_IMAGE\} \S.*$/mu;

// the ExecStartPre that writes PROBED_FILE
const PROBE = /^ExecStartPre=\/bin\/sh -c 'a=; .*'$/mu;

// the ExecStartPre that makes the IPv6 network
const NETWORK_START = /^ExecStartPre=\/bin\/sh -c 'case "\$\$IMP_HOST_NETWORK" in .*'$/mu;
const PROBED_FILE = '/run/imp-host/probed.env';
const COMPOSE_HEAD = '    # privileges: from deploy/imp-host.args.json (bun run render:deploy)\n';
const COMPOSE_TAIL = '    # end of privileges\n';

const PROXY_COMPOSE_HEAD =
  '    # proxy privileges: from deploy/imp-host.args.json (bun run render:deploy)\n';

const PROXY_COMPOSE_TAIL = '    # end of proxy privileges\n';
const COMPOSE_NETWORK_HEAD = '# network: from deploy/imp-host.args.json (bun run render:deploy)\n';
const COMPOSE_NETWORK_TAIL = '# end of network\n';

// imp-host's two commented lines that join the network
const COMPOSE_SERVICE_NETWORKS = /^ {4}# networks:\n {4}# {3}- .*$/mu;

// host-env.sh's lines that the network and the address pipeline go into
const HOST_ENV_NETWORK = /^readonly HOST_NETWORK=.*$/mu;
const HOST_ENV_BRIDGE = /^readonly HOST_BRIDGE=.*$/mu;
const HOST_ENV_ADDRESSES = /^host_addresses\(\) \{ .* \}$/mu;

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

// the Docker network imp-host runs on with IPv6, and its bridge, which a firewall names
interface HostNetwork {
  readonly name: string;
  readonly bridge: string;
}

export interface HostArgs {
  // replaces --privileged (docs/architecture/host.md#privileges)
  readonly privileges: Lines;

  readonly probed: readonly Probed[];
  readonly lines: Lines;
  readonly proxy: ProxyArgs;
  readonly network: HostNetwork;

  // the shell pipeline that prints the host's own addresses, for IMP_HOST_ADDRESSES
  readonly addresses: string;
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

// a Docker network's name, and a Linux interface name of at most 15 bytes
const HostNetworkSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/u, { error: 'is not a network name' }),
  bridge: z.string().regex(/^[a-z][a-z0-9-]{0,14}$/u, { error: 'is not a bridge name' }),
});

// it goes into the unit's sh -c '...' and into a shell function, each on one line
const AddressesSchema = z
  .string()
  .regex(/^[^'\n$]+$/u, { error: 'must be one line without a quote or a $' });

const HostArgsSchema = z.object({
  privileges: PrivilegeLinesSchema,
  probed: z.array(ProbedSchema),
  lines: LinesSchema,
  proxy: ProxyArgsSchema,
  network: HostNetworkSchema,
  addresses: AddressesSchema,
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
// (docs/architecture/network/egress.md#public), read at each start for a new DHCP lease.
export function renderProbe(probed: readonly Probed[], addresses: string): string {
  const tests = probed.map((entry) => `[ -e ${entry.path} ] && a="$$a ${entry.args.join(' ')}"; `);

  return `ExecStartPre=/bin/sh -c 'a=; ${tests.join('')}{ echo "IMP_HOST_PROBED=$$a"; echo "IMP_HOST_ADDRESSES=$$(${addresses})"; } >${PROBED_FILE}'`;
}

// with IPv6 (IMP_HOST_NETWORK names the network), the network on IMP_HOST_SUBNET6 when missing
export function renderNetworkStart(network: HostNetwork): string {
  const create = `/usr/bin/docker network create --ipv6 --subnet "$$IMP_HOST_SUBNET6" -o com.docker.network.bridge.name=${network.bridge} ${network.name}`;

  return `ExecStartPre=/bin/sh -c 'case "$$IMP_HOST_NETWORK" in *${network.name}*) /usr/bin/docker network inspect ${network.name} >/dev/null 2>&1 || ${create} ;; esac'`;
}

export function renderUnit(unit: string, args: HostArgs): string {
  if (!EXEC_START.test(unit)) {
    throw new Error(`${UNIT_FILE}: no docker run ExecStart that ends in \${IMP_HOST_IMAGE}`);
  }

  if (!PROBE.test(unit)) {
    throw new Error(`${UNIT_FILE}: no ExecStartPre=/bin/sh -c '...' for the probed args`);
  }

  if (!NETWORK_START.test(unit)) {
    throw new Error(`${UNIT_FILE}: no ExecStartPre=/bin/sh -c 'case ...' for the IPv6 network`);
  }

  // functions: a replacement string would read $$ as one $
  return unit
    .replace(EXEC_START, () => renderExecStart(args))
    .replace(PROBE, () => renderProbe(args.probed, args.addresses))
    .replace(NETWORK_START, () => renderNetworkStart(args.network));
}

// the network and the address pipeline into host-env.sh, which the NixOS module and upgrade.sh
// source, and bootstrap.sh copies
export function renderHostEnv(hostEnv: string, args: HostArgs): string {
  const lines = [
    ['HOST_NETWORK', HOST_ENV_NETWORK, `readonly HOST_NETWORK=${args.network.name}`],
    ['HOST_BRIDGE', HOST_ENV_BRIDGE, `readonly HOST_BRIDGE=${args.network.bridge}`],
    ['host_addresses', HOST_ENV_ADDRESSES, `host_addresses() { ${args.addresses}; }`],
  ] as const;

  return lines.reduce((text, [name, pattern, line]) => {
    if (!pattern.test(text)) {
      throw new Error(`${HOST_ENV_FILE}: no line for ${name}`);
    }

    return text.replace(pattern, () => line);
  }, hostEnv);
}

// the compose keys of the docker run flags that privileges uses, with their values
const COMPOSE_SCALARS: Readonly<Record<string, readonly [string, boolean | string]>> = {
  '--init': ['init', true],
  '--cgroupns=private': ['cgroup', 'private'],
  '--read-only': ['read_only', true],
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

// a service's keys for privileges: the scalars in their order, then each list
function renderComposeKeys(privileges: Lines): string {
  const doc = new Document(new YAMLMap());
  const keys = new YAMLMap();
  const lists = new Map<string, string[]>();

  const words = privileges.flat();

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    const scalar = COMPOSE_SCALARS[word];
    const valued = COMPOSE_VALUES[word];
    const list = COMPOSE_LISTS[word];

    if (scalar !== undefined) {
      keys.add(doc.createPair(scalar[0], scalar[1]));
    } else if (valued !== undefined) {
      index += 1;

      // quoted as oxfmt writes YAML, so 65534:65534 stays a string
      const value = new Scalar(words[index] ?? '');

      value.type = Scalar.QUOTE_SINGLE;

      keys.add(doc.createPair(valued, value));
    } else if (list === undefined) {
      throw new Error(`${ARGS_FILE}: no compose key for the privilege ${word}`);
    } else {
      index += 1;

      lists.set(list, [...(lists.get(list) ?? []), words[index] ?? '']);
    }
  }

  for (const [key, values] of lists) {
    keys.add(doc.createPair(key, values));
  }

  doc.contents = keys;

  return doc.toString();
}

// the top-level networks block, commented out: the operator turns IPv6 on by uncommenting it
function renderComposeNetwork(network: HostNetwork): string {
  const doc = new Document({
    networks: {
      [network.name]: {
        name: network.name,
        enable_ipv6: true,
        driver_opts: { 'com.docker.network.bridge.name': network.bridge },

        // oxlint-disable-next-line no-template-curly-in-string -- compose interpolates it
        ipam: { config: [{ subnet: '${IMP_HOST_SUBNET6:?set IMP_HOST_SUBNET6 to a /64}' }] },
      },
    },
  });

  return buildPrefixedLines(doc.toString(), '# ');
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
  return mergeBetween(
    compose,
    head,
    tail,
    buildPrefixedLines(renderComposeKeys(privileges), '    '),
  );
}

// each line of text that is not empty, after prefix
function buildPrefixedLines(text: string, prefix: string): string {
  return text.replaceAll(/^(?=.)/gmu, prefix);
}

// text with block in place of what lies between head and tail
function mergeBetween(text: string, head: string, tail: string, block: string): string {
  const start = text.indexOf(head);
  const end = text.indexOf(tail, start);

  if (start === -1 || end === -1) {
    throw new Error(`${COMPOSE_FILE}: no block from ${JSON.stringify(head.trim())}`);
  }

  return text.slice(0, start + head.length) + block + text.slice(end);
}

export function renderCompose(compose: string, privileges: Lines): string {
  return renderComposeBlock(compose, privileges, COMPOSE_HEAD, COMPOSE_TAIL);
}

// the networks block, and the two lines of imp-host that join the network
export function renderComposeNetworks(compose: string, network: HostNetwork): string {
  if (!COMPOSE_SERVICE_NETWORKS.test(compose)) {
    throw new Error(`${COMPOSE_FILE}: no commented networks of imp-host`);
  }

  return mergeBetween(
    compose,
    COMPOSE_NETWORK_HEAD,
    COMPOSE_NETWORK_TAIL,
    renderComposeNetwork(network),
  ).replace(COMPOSE_SERVICE_NETWORKS, () => `    # networks:\n    #   - ${network.name}`);
}

// a file of the checkout: its path from the root, and its text
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

// a deploy file that bootstrap.sh prints from a function, so it runs without a checkout
export interface DeployFile extends SourceFile {
  readonly function: string;
}

const GENERATED_HEAD =
  '#!/bin/bash\n' +
  '# Generated by bun run render:deploy (scripts/render/render-imp-host.ts) from the parts in\n' +
  '# deploy/bootstrap/ and deploy/lib/host-env.sh: edit those, then run it again.\n';

// a part's own directive; the generated file has its shebang instead
const PART_DIRECTIVE = /^# shellcheck shell=bash\n/u;

// the parts in their order, each under the path it came from, with the deploy files after
// UNITS_PART
export function renderBootstrap(
  parts: readonly SourceFile[],
  deployFiles: readonly DeployFile[],
): string {
  if (!parts.some((part) => part.path === UNITS_PART)) {
    throw new Error(`${BOOTSTRAP_FILE}: no part ${UNITS_PART} for the deploy files to follow`);
  }

  const sections = parts.flatMap((part) => {
    const section = `# --- ${part.path} ---\n\n${part.text.replace(PART_DIRECTIVE, '')}`;

    return part.path === UNITS_PART ? [section, renderDeployFiles(deployFiles)] : [section];
  });

  return `${GENERATED_HEAD}\n${sections.join('\n')}`;
}

// each deploy file as a function that prints it, in a quoted heredoc
function renderDeployFiles(deployFiles: readonly DeployFile[]): string {
  const functions = deployFiles.map((file) => {
    if (/^EOF$/mu.test(file.text)) {
      throw new Error(`${file.path}: a line EOF would end its heredoc in ${BOOTSTRAP_FILE}`);
    }

    return `${file.function}() {\n  cat <<'EOF'\n${file.text.replace(/\n+$/u, '')}\nEOF\n}\n`;
  });

  const paths = deployFiles.map((file) => file.path).join(', ');

  return `# --- ${paths} ---\n\n${functions.join('\n')}`;
}

export interface Rendered {
  readonly unit: string;
  readonly proxyUnit: string;
  readonly hostEnv: string;
  readonly bootstrap: string;
  readonly compose: string;
}

// what bootstrap.sh is made of, beside the units render writes
export interface BootstrapSources {
  readonly parts: readonly SourceFile[];
  readonly envExample: string;
}

export function render(argsJson: string, current: Rendered, sources: BootstrapSources): Rendered {
  const args = readHostArgs(argsJson);
  const unit = renderUnit(current.unit, args);
  const proxyUnit = renderProxyUnit(current.proxyUnit, args.proxy);
  const hostEnv = renderHostEnv(current.hostEnv, args);

  const compose = renderCompose(renderComposeNetworks(current.compose, args.network), [
    ...args.privileges,
    ...buildComposeProbed(args.probed),
  ]);

  // bootstrap.sh copies host-env.sh as rendered here, not as it was read
  const parts = sources.parts.map((part) =>
    part.path === HOST_ENV_FILE ? { path: part.path, text: hostEnv } : part,
  );

  return {
    unit,
    proxyUnit,
    hostEnv,
    bootstrap: renderBootstrap(parts, [
      { path: UNIT_FILE, function: 'unit_imp_host', text: unit },
      { path: PROXY_UNIT_FILE, function: 'unit_imp_docker_proxy', text: proxyUnit },
      { path: ENV_EXAMPLE_FILE, function: 'env_template', text: sources.envExample },
    ]),
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
  hostEnv: HOST_ENV_FILE,
  bootstrap: BOOTSTRAP_FILE,
  compose: COMPOSE_FILE,
} as const;

const KEYS = ['unit', 'proxyUnit', 'hostEnv', 'bootstrap', 'compose'] as const;

function main(): void {
  const current: Rendered = {
    unit: readFileSync(UNIT_FILE, 'utf8'),
    proxyUnit: readFileSync(PROXY_UNIT_FILE, 'utf8'),
    hostEnv: readFileSync(HOST_ENV_FILE, 'utf8'),
    bootstrap: readFileSync(BOOTSTRAP_FILE, 'utf8'),
    compose: readFileSync(COMPOSE_FILE, 'utf8'),
  };

  const sources: BootstrapSources = {
    parts: BOOTSTRAP_PARTS.map((path) => ({ path, text: readFileSync(path, 'utf8') })),
    envExample: readFileSync(ENV_EXAMPLE_FILE, 'utf8'),
  };

  const next = render(readFileSync(ARGS_FILE, 'utf8'), current, sources);
  const stale = KEYS.filter((key) => next[key] !== current[key]).map((key) => FILES[key]);

  if (process.argv.includes('--check')) {
    if (stale.length > 0) {
      console.error(
        `render-imp-host: ${stale.join(', ')} differ from their sources; run bun run render:deploy`,
      );

      process.exit(1);
    }

    console.log(`render-imp-host: ${Object.values(FILES).join(', ')} match their sources`);

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
