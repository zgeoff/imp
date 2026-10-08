import { onTestFinished } from 'bun:test';
import type { KyselyPlugin } from 'kysely';

// Holds the result of the first select that names `name` once armed, until
// released: a build stops there between finding its rootfs and its row. The
// test's end releases a select still held; a second release does nothing.
export function buildQueryGate(name: string) {
  const state = { armed: false, held: new Set<unknown>() };
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();

  onTestFinished(() => {
    released.resolve();
  });

  const plugin: KyselyPlugin = {
    transformQuery: (args) => {
      const isNamed =
        args.node.kind === 'SelectQueryNode' && JSON.stringify(args.node).includes(`"${name}"`);

      if (state.armed && isNamed) {
        state.armed = false;

        state.held.add(args.queryId);
      }

      return args.node;
    },
    transformResult: async (args) => {
      if (state.held.has(args.queryId)) {
        reached.resolve();

        await released.promise;
      }

      return args.result;
    },
  };

  return {
    plugin,
    arm: () => {
      state.armed = true;
    },
    reached: reached.promise,
    release: () => {
      released.resolve();
    },
  };
}
