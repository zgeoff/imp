import { withAuditedOpen } from '../audit/api-audit';
import type { ApiAudit } from '../audit/api-audit';
import type { Revocations } from '../auth/revocations';
import type { TokenStore } from '../auth/token-store';
import type { Config } from '../config';
import { findImpByName } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import type { ImpRuntime } from '../imps/imp-runtime';
import { readErrorMessage } from '../read-error-message';
import type { AuthorizedKeys } from './authorized-keys';
import { loadOrCreateHostKey, readFingerprint, setupSshDir } from './host-key';
import { createLoginKeys } from './login-keys';
import { startSshGateway } from './ssh-gateway';
import type { SshGateway } from './ssh-gateway';

interface StartSshDeps {
  readonly config: Pick<Config, 'dataDir' | 'sshPort' | 'sshAuthorizedKeys'>;
  readonly db: ImpDatabase;

  // <data>/ssh/authorized_keys (createAuthorizedKeys)
  readonly authorizedKeys: AuthorizedKeys;
  readonly tokens: Pick<TokenStore, 'findSshKey'>;
  readonly revocations: Pick<Revocations, 'readSignal'>;
  readonly imps: Pick<
    ImpRuntime,
    | 'requireRunning'
    | 'tracker'
    | 'openExec'
    | 'openDial'
    | 'openAgentListener'
    | 'openAgentAccept'
    | 'recordActivity'
  >;
  readonly log: (message: string) => void;
  readonly audit: ApiAudit;
  readonly now: () => number;
}

// every interface of the container's own network namespace: the tailnet
// (tailscale0) and the published port for local use. IPv4 only, see
// startSshGateway.
const LISTEN_HOST = '0.0.0.0';

// The SSH gateway, unless IMP_SSH_PORT=0 turns it off. A gateway that cannot
// start is logged, not fatal: the API and the proxy still serve.
export async function startSsh(deps: StartSshDeps): Promise<SshGateway | null> {
  const port = deps.config.sshPort;

  if (port === null) {
    return null;
  }

  const imps = deps.imps;

  try {
    const sshDir = setupSshDir(deps.config.dataDir);
    const hostKey = loadOrCreateHostKey(sshDir);

    const gateway = await startSshGateway(
      {
        hostKey,
        keys: createLoginKeys({
          findBound: deps.tokens.findSshKey,
          file: deps.config.sshAuthorizedKeys ? deps.authorizedKeys : null,
        }),
        readRevocation: deps.revocations.readSignal,
        backend: {
          requireRunning: imps.requireRunning,
          tracker: imps.tracker,

          // each shell, command or sftp an ssh login opens is audited,
          // as who logged in
          openExec: (name, request, feature, actor) =>
            withAuditedOpen(
              deps.audit,
              {
                procedure: 'ssh',
                actor,
                impName: name,
                startedAt: deps.now(),
              },
              () => imps.openExec(name, request, feature),
            ),
          openDial: imps.openDial,
          openAgentListener: imps.openAgentListener,
          openAgentAccept: imps.openAgentAccept,
          recordActivity: imps.recordActivity,
          findImp: (name) => findImpByName(deps.db, name),
        },
        log: deps.log,
      },
      port,
      LISTEN_HOST,
    );

    deps.log(`impd: ssh on :${String(gateway.port)}, host key ${readFingerprint(hostKey)}`);

    return gateway;
  } catch (error) {
    deps.log(`impd: ssh: not started on :${String(port)}: ${readErrorMessage(error)}`);

    return null;
  }
}
