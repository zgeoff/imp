import { TEST_TOKEN } from '@imp/daemon/src/imps/test-imps';
import { createMoveHosts, createUbuntuImage } from '@imp/daemon/src/moves/test-moves';
import { invariant } from '@imp/test-utils/invariant';
import { createImpClient } from '@zgeoff/imp-client';

// Two impds that can take a warm move, with the ubuntu image, on loopback
// ports. They cannot share a data dir, so both report the target's facts.
// Every release goes into `stack`; the listeners close before the impds.
export async function startWarmMoveHosts(stack: Readonly<AsyncDisposableStack>) {
  const hosts = await createMoveHosts(stack, { isShared: true });

  await createUbuntuImage(hosts.source);
  await createUbuntuImage(hosts.target);

  const source = hosts.sourceApp.app.listen({ port: 0, hostname: '127.0.0.1' });

  stack.defer(async () => {
    await source.stop(true);
  });

  const target = hosts.targetApp.app.listen({ port: 0, hostname: '127.0.0.1' });

  stack.defer(async () => {
    await target.stop(true);
  });

  const sourcePort = source.server?.port;
  const targetPort = target.server?.port;

  invariant(sourcePort);
  invariant(targetPort);

  return {
    from: createImpClient({ url: `http://127.0.0.1:${String(sourcePort)}`, token: TEST_TOKEN }),
    to: createImpClient({ url: `http://127.0.0.1:${String(targetPort)}`, token: TEST_TOKEN }),
  };
}
