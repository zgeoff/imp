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
    openExec: (name, request) => {
      const procedure = request.tty ? 'console' : 'exec';

      return withAuditedOpen(audit, buildCall(procedure, name), () =>
        backend.openExec(name, request),
      );
    },
    openAttach: (name, request) =>
      withAuditedOpen(audit, buildCall('attach', name), () => backend.openAttach(name, request)),
    recordActivity: (name) => backend.recordActivity(name),
  };
}
