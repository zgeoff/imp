import { EVENT_VERSION } from '@imp/api';
import type { AgentFeature } from '../agent-client/agent-outdated';
import type { AgentExecRequest } from '../agent-client/exec-stream';
import { withAuditedOpen } from '../audit/api-audit';
import type { ApiAudit } from '../audit/api-audit';
import type { AuditActor } from '../auth/caller';
import type { EventBus } from '../events/event-bus';
import type { ExecBackend } from './exec-session';

// Every exec, console and attach an `/exec` socket opens leaves an audit row:
// a terminal exec is a console. An exec in the agent's world is an event
// too, once the agent took it, so a refused one never reads as a run.
export function buildAuditedBackend(
  backend: ExecBackend,
  audit: ApiAudit,
  actor: AuditActor,
  events: EventBus,
  now: () => number,
): ExecBackend {
  const buildCall = (procedure: string, name: string) => ({
    procedure,
    actor,
    impName: name,
    startedAt: now(),
  });

  return {
    openExec: async (name, request, feature) => {
      const procedure = readProcedure(request, feature);

      const stream = await withAuditedOpen(audit, buildCall(procedure, name), () =>
        backend.openExec(name, request, feature),
      );

      if (request.outer === true) {
        events.publish({
          v: EVENT_VERSION,
          at: new Date(now()),
          ev: 'AgentExec',
          name,
          actor: actor.kind,
          actorName: actor.name,
          tty: request.tty,
          command: request.argv[0] ?? '',
        });
      }

      return stream;
    },
    openAttach: (name, request) =>
      withAuditedOpen(audit, buildCall('attach', name), () => backend.openAttach(name, request)),
    recordActivity: (name) => backend.recordActivity(name),
  };
}

// `imp cp` runs the tar tool; its arguments name the path in the audit
function readProcedure(request: AgentExecRequest, feature: AgentFeature | undefined): string {
  if (request.outer === true) {
    return 'exec-agent';
  }

  if (feature === 'cp') {
    return 'cp';
  }

  return request.tty ? 'console' : 'exec';
}
