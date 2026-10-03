import { buildBrokerNotReadyError } from './exec-require';

// The sessions each imp's current boot started with `require: ['broker']`.
// A start that requires the broker and attaches to a running session passes
// only when that session was one of them.
export interface BrokerSessions {
  // after the agent opened a session: a new one is recorded (boot set, as
  // the start required the broker) or dropped (boot null); an attach that
  // requires the broker is refused unless the record covers it
  readonly note: (
    impId: string,
    name: string,
    created: boolean,
    boot: string | null,
  ) => Error | null;
}

export function createBrokerSessions(): BrokerSessions {
  const byImp = new Map<string, { readonly boot: string; readonly names: Set<string> }>();

  return {
    note: (impId, name, created, boot) => {
      const known = byImp.get(impId);

      if (created) {
        if (boot === null) {
          known?.names.delete(name);
        } else {
          const names = known?.boot === boot ? known.names : new Set<string>();

          names.add(name);
          byImp.set(impId, { boot, names });
        }

        return null;
      }

      if (boot === null || (known?.boot === boot && known.names.has(name))) {
        return null;
      }

      return buildBrokerNotReadyError(`session ${name} was started without the broker requirement`);
    },
  };
}
