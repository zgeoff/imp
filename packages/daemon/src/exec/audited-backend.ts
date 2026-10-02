import type { AgentFeature } from '../agent-client/agent-outdated';
import { withAuditedOpen } from '../audit/api-audit';
import type { ApiAudit } from '../audit/api-audit';
import type { AuditActor } from '../auth/caller';
import type { ExecBackend } from './exec-session';

// Every exec, console and attach an `/exec` socket opens leaves an audit row:
// a terminal exec is a console.
export function buildAuditedBackend(
  backend: ExecBackend,
  audit: ApiAudit,
  actor: AuditActor,
  now: () => number,
): ExecBackend {
  const buildCall = (procedure: string, name: string) => ({
    procedure,
    actor,
    impName: name,
    startedAt: now(),
  });

  return {
    openExec: (name, request, feature) => {
      const procedure = readProcedure(request.tty, feature);

      return withAuditedOpen(audit, buildCall(procedure, name), () =>
        backend.openExec(name, request, feature),
      );
    },
    openAttach: (name, request) =>
      withAuditedOpen(audit, buildCall('attach', name), () => backend.openAttach(name, request)),
    recordActivity: (name) => backend.recordActivity(name),
  };
}

// `imp cp` runs the tar tool; its arguments name the path in the audit
function readProcedure(tty: boolean, feature: AgentFeature | undefined): string {
  if (feature === 'cp') {
    return 'cp';
  }

  return tty ? 'console' : 'exec';
}
