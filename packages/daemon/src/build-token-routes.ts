import { toIdentity } from './auth/caller';
import type { RouterDeps, RpcImplementer } from './build-router';

// `tokens.*`: the API tokens, their lists and their SSH keys
// oxlint-disable-next-line prefer-readonly-parameter-types -- an oRPC implementer, a builder with no readonly form
export function buildTokenRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    list: os.tokens.list.handler(() => deps.tokens.list()),
    create: os.tokens.create.handler((context) =>
      deps.tokens.create({
        name: context.input.name,
        scope: context.input.scope,
        imps: context.input.imps ?? null,
        sshKeys: context.input.sshKeys ?? [],
        grantable: context.input.grantable ?? [],
        ...(context.input.imageRefPrefix !== undefined && {
          imageRefPrefix: context.input.imageRefPrefix,
        }),
      }),
    ),

    // a secret taken off the list ends its grants on the token's imps, so
    // the broker drops what no grant covers any more
    update: os.tokens.update.handler(async (context) => {
      const updated = await deps.tokens.update(context.input.name, {
        ...(context.input.grantable !== undefined && { grantable: context.input.grantable }),
        ...(context.input.imageRefPrefix !== undefined && {
          imageRefPrefix: context.input.imageRefPrefix,
        }),
      });

      if (updated.droppedGrants > 0) {
        await deps.broker.applyGrants();
      }

      return updated.token;
    }),
    delete: os.tokens.delete.handler(async (context) => {
      await deps.tokens.remove(context.input.name);

      return {};
    }),
    addKey: os.tokens.addKey.handler((context) =>
      deps.tokens.addKey(context.input.name, context.input.key),
    ),
    removeKey: os.tokens.removeKey.handler(async (context) => {
      await deps.tokens.removeKey(context.input.name, context.input.fingerprint);

      return {};
    }),
    whoami: os.tokens.whoami.handler((context) => toIdentity(context.context.caller)),
  };
}
