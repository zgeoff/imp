import { createHash } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { openExecStream } from '../agent-client/exec-stream';
import { readErrorMessage } from '../read-error-message';

// How a guest trusts the broker: an exec writes the (public) CA bundle in
// once per boot, before the first exec that gets the broker's variables.

const GUEST_BUNDLE_PATH = '/etc/imp/broker-ca.pem';

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

export function buildGuestBundle(caPem: string): string {
  return `${[...rootCertificates, caPem.trim()].join('\n')}\n`;
}

// The shell script that writes the bundle from stdin, unless the file
// already holds it. It reads stdin either way, so the host's write never
// meets a closed pipe.
function buildInstallScript(bundle: string): string {
  const digest = createHash('sha256').update(bundle).digest('hex');
  const path = GUEST_BUNDLE_PATH;

  return [
    'set -e',
    `if [ -f ${path} ] && [ "$(cat ${path}.sha256 2>/dev/null)" = ${digest} ]; then`,
    '  cat >/dev/null',
    '  exit 0',
    'fi',
    `mkdir -p ${path.slice(0, path.lastIndexOf('/'))}`,
    `cat > ${path}.tmp`,
    `mv ${path}.tmp ${path}`,
    `echo ${digest} > ${path}.sha256`,
  ].join('\n');
}

export interface TrustedImp {
  readonly id: string;
  readonly name: string;

  // the Firecracker pid: a new one is a new boot or wake
  readonly pid: number | null;
}

export type InstallBundle = (vsockPath: string, bundle: string) => Promise<void>;

export interface GuestTrust {
  // true once the bundle is in this boot of the imp; one install runs per
  // boot however many execs wait on it
  readonly ensure: (imp: TrustedImp, vsockPath: string) => Promise<boolean>;

  // drops what it knows of imps that no longer exist
  readonly forgetExcept: (impIds: ReadonlySet<string>) => void;
}

export function createGuestTrust(
  bundle: string,
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

      const runInstall = async (): Promise<boolean> => {
        try {
          await install(vsockPath, bundle);

          return true;
        } catch (error) {
          log(
            `impd: ${imp.name}: broker CA not installed, so execs run without the broker: ${readErrorMessage(error)}`,
          );

          return false;
        }
      };

      const done = runInstall();

      installs.set(imp.id, { pid: imp.pid, done });

      return done;
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
// passwd entry), with the bundle on stdin.
export async function runBundleInstall(vsockPath: string, bundle: string): Promise<void> {
  const stream = await openExecStream(vsockPath, {
    argv: ['/bin/sh', '-c', buildInstallScript(bundle)],
    tty: false,
    user: '0',
  });

  const timer = setTimeout(() => {
    stream.close();
  }, INSTALL_TIMEOUT_MS);

  try {
    stream.writeStdin(new TextEncoder().encode(bundle));
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
