import type { Image, Imp, ImpContract } from '@imp/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { buildImage } from './build-image';
import type { BuildContext, BuildImageOptions } from './build-image';
import { checkServer } from './check-server';
import type { ServerCheck } from './check-server';
import { openAttach, openConsole, openExec, runCommand } from './exec/open-exec';
import type {
  AttachOptions,
  ConsoleOptions,
  ExecDeps,
  ExecHandle,
  ExecOptions,
  RunOptions,
  RunResult,
} from './exec/open-exec';
import type { ExecSocket } from './exec/open-exec-session';
import { requireAwake } from './require-awake';
import type { RequireAwakeOptions } from './require-awake';
import { resolveImpdUrl } from './resolve-impd-url';

type RpcClient = ContractRouterClient<ImpContract>;

export interface ImpClientOptions {
  // impd's API, e.g. http://localhost:7070; a path prefix is kept, so impd
  // can sit behind a reverse proxy at /impd/
  readonly url: string;

  // the bearer token from `<IMP_DATA_DIR>/token`; leave it out when a proxy
  // in front of impd adds it, as a browser app should
  readonly token?: string;

  // swaps the transport, e.g. an in-process app in tests
  readonly fetch?: (request: Request) => Promise<Response>;

  // opens the `/exec` socket; impd's own MCP endpoint bridges it in process
  readonly connect?: (url: string) => ExecSocket;
}

export interface ImpClient extends RpcClient {
  // one wake call; see require-awake.ts
  readonly requireAwake: (name: string, options?: RequireAwakeOptions) => Promise<Imp>;

  // whether impd speaks this client's version of the API
  readonly checkServer: () => Promise<ServerCheck>;

  // builds an image from a tar of its build context, uploaded from here;
  // `images.build` takes a directory on the impd host instead
  readonly buildImage: (
    name: string,
    context: BuildContext,
    options?: BuildImageOptions,
  ) => Promise<Image>;

  // a command with streamed stdio over `/exec`, authenticated by an exec
  // ticket; named so, because `exec` is the contract's namespace
  readonly openExec: (
    name: string,
    argv: readonly string[],
    options?: ExecOptions,
  ) => Promise<ExecHandle>;

  // a command run to its exit, with its output collected
  readonly run: (name: string, argv: readonly string[], options?: RunOptions) => Promise<RunResult>;

  // a login shell with a tty; with `session`, one that outlives the handle
  readonly openConsole: (name: string, options?: ConsoleOptions) => Promise<ExecHandle>;

  // attaches to a running session (`sessions.list` names them)
  readonly openAttach: (
    name: string,
    session: string,
    options?: AttachOptions,
  ) => Promise<ExecHandle>;
}

export function createImpClient(options: Readonly<ImpClientOptions>): ImpClient {
  const token = options.token;
  const customFetch = options.fetch;

  const link = new RPCLink({
    url: resolveImpdUrl(options.url, '/rpc').href,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    ...(customFetch !== undefined && { fetch: (request: Request) => customFetch(request) }),
  });

  const rpc: RpcClient = createORPCClient(link);

  // the oRPC client is a proxy, so its namespaces are copied one by one;
  // `satisfies` fails the build when the contract grows a namespace
  const namespaces = {
    imps: rpc.imps,
    leases: rpc.leases,
    checkpoints: rpc.checkpoints,
    backups: rpc.backups,
    images: rpc.images,
    exec: rpc.exec,
    sessions: rpc.sessions,
    services: rpc.services,
    moves: rpc.moves,
    secrets: rpc.secrets,
    networks: rpc.networks,
    grants: rpc.grants,
    audit: rpc.audit,
    events: rpc.events,
    system: rpc.system,
    tokens: rpc.tokens,
  } satisfies RpcClient;

  const execDeps: ExecDeps = {
    rpc,
    baseUrl: options.url,
    token: token ?? null,
    ...(customFetch !== undefined && { fetch: customFetch }),
    ...(options.connect !== undefined && { connect: options.connect }),
  };

  return {
    ...namespaces,
    openExec: (name, argv, execOptions) => openExec(execDeps, name, argv, execOptions),
    run: (name, argv, runOptions) => runCommand(execDeps, name, argv, runOptions),
    openConsole: (name, consoleOptions) => openConsole(execDeps, name, consoleOptions),
    openAttach: (name, session, attachOptions) =>
      openAttach(execDeps, name, session, attachOptions),
    requireAwake: (name, awakeOptions) => requireAwake(rpc, name, awakeOptions),
    checkServer: () => checkServer(rpc),
    buildImage: (name, context, buildOptions) => buildImage(execDeps, name, context, buildOptions),
  };
}
