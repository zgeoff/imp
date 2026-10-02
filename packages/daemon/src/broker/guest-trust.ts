import { rootCertificates } from 'node:tls';
import { openExecStream } from '../agent-client/exec-stream';
import { readErrorMessage } from '../read-error-message';

// How a guest trusts the broker: an exec builds the CA bundle in the guest
// once per boot, before the first exec that gets the broker's variables.

const GUEST_BUNDLE_PATH = '/etc/imp/broker-ca.pem';

// where distros keep their root bundle: Debian, Ubuntu, Alpine and Arch;
// Fedora and RHEL; openSUSE; the BSD-style name some images use
const GUEST_ROOT_PATHS = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/ssl/cert.pem',
];

// between the broker CA and the host's roots on the install's stdin
const ROOTS_MARKER = '# imp: host roots';

// the variables each TLS stack reads for its trust store
const CA_VARIABLES = [
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSL_CAINFO',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];

// within this the install must finish, or the exec goes on without the broker
const INSTALL_TIMEOUT_MS = 10_000;

export interface BrokerEnvInput {
  readonly proxyUrl: string;
  readonly placeholders: readonly string[];
  readonly placeholder: string;
}

// `KEY=VALUE` entries for an exec. Both spellings of the proxy variables,
// since tools disagree on which they read; NODE_USE_ENV_PROXY makes Node's
// own fetch use them.
export function buildBrokerEnv(input: BrokerEnvInput): readonly string[] {
  const local = 'localhost,127.0.0.1,::1';

  return [
    `HTTPS_PROXY=${input.proxyUrl}`,
    `https_proxy=${input.proxyUrl}`,
    `NO_PROXY=${local}`,
    `no_proxy=${local}`,
    'NODE_USE_ENV_PROXY=1',
    ...CA_VARIABLES.map((name) => `${name}=${GUEST_BUNDLE_PATH}`),
    ...input.placeholders.map((name) => `${name}=${input.placeholder}`),
  ];
}

// The install's stdin: the broker CA, then the host's roots, which the
// guest uses only when it has no root bundle of its own.
export function buildInstallInput(caPem: string): string {
  return `${caPem.trim()}\n${ROOTS_MARKER}\n${rootCertificates.join('\n')}\n`;
}

// The script that builds the bundle in the guest: the guest's own roots
// (CAs it added included) plus the broker CA. It leaves the file alone when
// it already holds that, so a wake does not write to the disk.
export function buildInstallScript(
  target = GUEST_BUNDLE_PATH,
  rootPaths: readonly string[] = GUEST_ROOT_PATHS,
): string {
  const input = `${target}.in`;
  const next = `${target}.tmp`;

  return [
    'set -e',
    `mkdir -p "$(dirname '${target}')"`,
    `cat > '${input}'`,
    'roots=',
    `for f in ${rootPaths.map((path) => `'${path}'`).join(' ')}; do`,
    '  if [ -s "$f" ]; then roots=$f; break; fi',
    'done',
    '{',
    `  if [ -n "$roots" ]; then cat "$roots"; else sed '1,/^${ROOTS_MARKER}$/d' '${input}'; fi`,
    '  echo',
    `  sed '/^${ROOTS_MARKER}$/,$d' '${input}'`,
    `} > '${next}'`,
    `rm -f '${input}'`,
    `if [ -f '${target}' ] && [ "$(cat '${next}')" = "$(cat '${target}')" ]; then`,
    `  rm -f '${next}'`,
    'else',
    `  mv '${next}' '${target}'`,
    'fi',
  ].join('\n');
}

export interface TrustedImp {
  readonly id: string;
  readonly name: string;

  // the Firecracker pid: a new one is a new boot or wake
  readonly pid: number | null;
}

// writes the bundle into the guest from buildInstallInput's text
export type InstallBundle = (vsockPath: string, input: string) => Promise<void>;

export interface GuestTrust {
  // true once the bundle is in this boot of the imp; one install runs per
  // boot however many execs wait on it
  readonly ensure: (imp: TrustedImp, vsockPath: string) => Promise<boolean>;

  // drops what it knows of imps that no longer exist
  readonly forgetExcept: (impIds: ReadonlySet<string>) => void;
}

export function createGuestTrust(
  input: string,
  install: InstallBundle,
  log: (message: string) => void,
): GuestTrust {
  const installs = new Map<
    string,
    { readonly pid: number | null; readonly done: Promise<boolean> }
  >();

  return {
    ensure: (imp, vsockPath) => {
      const known = installs.get(imp.id);

      if (known !== undefined && known.pid === imp.pid) {
        return known.done;
      }

      const entry: { pid: number | null; done: Promise<boolean> } = {
        pid: imp.pid,
        done: Promise.resolve(false),
      };

      // a failure is forgotten, so the next exec tries again
      const runInstall = async (): Promise<boolean> => {
        try {
          await install(vsockPath, input);

          return true;
        } catch (error) {
          log(
            `impd: ${imp.name}: broker CA not installed, so this exec runs without the broker: ${readErrorMessage(error)}`,
          );

          if (installs.get(imp.id) === entry) {
            installs.delete(imp.id);
          }

          return false;
        }
      };

      entry.done = runInstall();

      installs.set(imp.id, entry);

      return entry.done;
    },
    forgetExcept: (impIds) => {
      for (const id of installs.keys()) {
        if (!impIds.has(id)) {
          installs.delete(id);
        }
      }
    },
  };
}

// The install as an exec through the agent, as root (uid 0, which needs no
// passwd entry), with buildInstallInput's text on stdin.
export async function runBundleInstall(vsockPath: string, input: string): Promise<void> {
  const stream = await openExecStream(vsockPath, {
    argv: ['/bin/sh', '-c', buildInstallScript()],
    tty: false,
    user: '0',
  });

  const timer = setTimeout(() => {
    stream.close();
  }, INSTALL_TIMEOUT_MS);

  try {
    stream.writeStdin(new TextEncoder().encode(input));
    stream.closeStdin();

    const stderr: string[] = [];

    for await (const event of stream.events()) {
      if (event.type === 'stderr') {
        stderr.push(new TextDecoder().decode(event.data));
      } else if (event.type === 'exit') {
        if (event.code !== 0 || event.signal !== 0) {
          throw new Error(`the install exited ${String(event.code)}: ${stderr.join('').trim()}`);
        }

        return;
      }
    }

    throw new Error('the install ended without an exit');
  } finally {
    clearTimeout(timer);

    stream.close();
  }
}
