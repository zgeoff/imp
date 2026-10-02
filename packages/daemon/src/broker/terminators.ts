import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LeafCertificate } from './broker-ca';

// One TLS server per (imp, host) on a unix socket only impd can open. Not
// one per imp with SNI: Bun serves an unknown SNI with the first
// certificate, and a reload does not swap certificates.

// a slow model call that answers in one piece can sit quiet for minutes;
// the guest's TCP connection decides when it is over
const IDLE_TIMEOUT_S = 0;

// a git push sends its whole pack in one request body
const MAX_REQUEST_BODY_BYTES = 8 * 1024 ** 3;

export interface TerminatorKey {
  readonly impId: string;
  readonly host: string;
}

export interface Terminators {
  // the socket for the pair, its server started on first use
  readonly open: (key: TerminatorKey) => Promise<string>;

  // stops every server whose pair `keep` rejects, or whose leaf is due;
  // requests under way finish
  readonly prune: (keep: (key: TerminatorKey) => boolean) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export interface TerminatorDeps {
  // a 0700 directory for the sockets; its old sockets are removed
  readonly socketDir: string;
  readonly issueLeaf: (host: string) => Promise<LeafCertificate>;
  readonly isLeafDue: (leaf: LeafCertificate) => boolean;
  readonly createHandler: (key: TerminatorKey) => (request: Request) => Promise<Response>;
}

interface Entry {
  readonly key: TerminatorKey;
  readonly socket: string;
  readonly leaf: LeafCertificate;

  // `force` cuts open connections; without it their requests finish
  readonly stop: (force: boolean) => Promise<void>;
}

export function createTerminators(deps: TerminatorDeps): Terminators {
  rmSync(deps.socketDir, { recursive: true, force: true });
  mkdirSync(deps.socketDir, { recursive: true, mode: 0o700 });

  const entries = new Map<string, Promise<Entry>>();

  const counter = { next: 0 };

  // short names: a unix socket path has a 108-byte limit
  const buildSocketPath = (): string => {
    counter.next += 1;

    return join(deps.socketDir, `${String(counter.next)}.sock`);
  };

  const start = async (key: TerminatorKey): Promise<Entry> => {
    const leaf = await deps.issueLeaf(key.host);

    const socket = buildSocketPath();

    // Bun's types leave idleTimeout off unix servers, but it applies there
    // too (10 s by default, which cuts off a slow model call)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    const options = {
      unix: socket,
      tls: { cert: leaf.certPem, key: leaf.keyPem },
      idleTimeout: IDLE_TIMEOUT_S,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      fetch: deps.createHandler(key),
    } as unknown as Bun.Serve.Options<undefined>;

    const server = Bun.serve(options);

    return {
      key,
      socket,
      leaf,
      stop: async (force) => {
        await server.stop(force);

        rmSync(socket, { force: true });
      },
    };
  };

  return {
    open: async (key) => {
      const id = `${key.impId}\n${key.host}`;
      const existing = entries.get(id);

      if (existing !== undefined) {
        const entry = await existing;

        return entry.socket;
      }

      const started = start(key);

      entries.set(id, started);

      try {
        const entry = await started;

        return entry.socket;
      } catch (error) {
        entries.delete(id);
        throw error;
      }
    },
    prune: async (keep) => {
      const stopping: Promise<void>[] = [];

      for (const [id, pending] of entries) {
        const entry = await readSettled(pending);

        if (entry === null || !keep(entry.key) || deps.isLeafDue(entry.leaf)) {
          entries.delete(id);

          if (entry !== null) {
            stopping.push(entry.stop(false));
          }
        }
      }

      await Promise.all(stopping);
    },
    stop: async () => {
      const all = await Promise.all([...entries.values()].map((pending) => readSettled(pending)));

      entries.clear();

      await Promise.all(
        all.map(async (entry) => {
          await entry?.stop(true);
        }),
      );

      rmSync(deps.socketDir, { recursive: true, force: true });
    },
  };
}

// a server that failed to start counts as none
async function readSettled(pending: Promise<Entry>): Promise<Entry | null> {
  try {
    return await pending;
  } catch {
    return null;
  }
}
