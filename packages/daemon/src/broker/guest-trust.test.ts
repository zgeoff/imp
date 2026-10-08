import { expect, mock, onTestFinished, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { invariant } from '@imp/test-utils/invariant';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '../agent-client/frame-codec';
import { startStubAgent } from '../test-utils/start-stub-agent';
import {
  buildBrokerEnv,
  buildInstallInput,
  buildInstallScript,
  createGuestTrust,
  runBundleInstall,
} from './guest-trust';
import type { InstallBundle } from './guest-trust';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dir = await mkdtemp(join(tmpdir(), 'imp-trust-'));

  stack.defer(() => rm(dir, { recursive: true, force: true }));

  return { stack, dir };
}

test('it gives an exec both spellings of the proxy, the CA bundle and the placeholders', () => {
  expect(
    buildBrokerEnv({
      proxyUrl: 'http://10.66.0.1:7081',
      placeholders: ['GH_TOKEN', 'GITHUB_TOKEN'],
      placeholder: 'imp-broker-placeholder',
    }),
  ).toStrictEqual([
    'HTTPS_PROXY=http://10.66.0.1:7081',
    'https_proxy=http://10.66.0.1:7081',
    'NO_PROXY=localhost,127.0.0.1,::1',
    'no_proxy=localhost,127.0.0.1,::1',
    'NODE_USE_ENV_PROXY=1',
    'SSL_CERT_FILE=/etc/imp/broker-ca.pem',
    'NODE_EXTRA_CA_CERTS=/etc/imp/broker-ca.pem',
    'GIT_SSL_CAINFO=/etc/imp/broker-ca.pem',
    'REQUESTS_CA_BUNDLE=/etc/imp/broker-ca.pem',
    'CURL_CA_BUNDLE=/etc/imp/broker-ca.pem',
    'GH_TOKEN=imp-broker-placeholder',
    'GITHUB_TOKEN=imp-broker-placeholder',
  ]);
});

test("it builds the bundle from the guest's own roots and the broker CA", async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dir, 'roots.pem'), 'GUEST ROOTS, A CA THE GUEST ADDED INCLUDED\n');

  const install = Bun.spawnSync(
    [
      'sh',
      '-c',
      buildInstallScript(join(ctx.dir, 'imp', 'broker-ca.pem'), [
        join(ctx.dir, 'missing.pem'),
        join(ctx.dir, 'roots.pem'),
      ]),
    ],
    {
      stdin: Buffer.from(
        buildInstallInput('-----BEGIN CERTIFICATE-----\nBROKER\n-----END CERTIFICATE-----'),
      ),
    },
  );

  expect(install.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, 'imp', 'broker-ca.pem'), 'utf8')).toBe(
    'GUEST ROOTS, A CA THE GUEST ADDED INCLUDED\n\n' +
      '-----BEGIN CERTIFICATE-----\nBROKER\n-----END CERTIFICATE-----\n',
  );
});

test('it leaves the bundle file as it was when the same bundle is installed again', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.dir, 'roots.pem'), 'GUEST ROOTS\n');

  const script = buildInstallScript(join(ctx.dir, 'imp', 'broker-ca.pem'), [
    join(ctx.dir, 'roots.pem'),
  ]);

  const input = Buffer.from(
    buildInstallInput('-----BEGIN CERTIFICATE-----\nBROKER\n-----END CERTIFICATE-----'),
  );

  Bun.spawnSync(['sh', '-c', script], { stdin: input });

  const before = statSync(join(ctx.dir, 'imp', 'broker-ca.pem')).ino;

  Bun.spawnSync(['sh', '-c', script], { stdin: input });

  expect(statSync(join(ctx.dir, 'imp', 'broker-ca.pem')).ino).toBe(before);
});

test('it gives a guest without roots the host roots and the broker CA', async () => {
  const ctx = await setupTest();

  const install = Bun.spawnSync(
    [
      'sh',
      '-c',
      buildInstallScript(join(ctx.dir, 'imp', 'broker-ca.pem'), [join(ctx.dir, 'missing.pem')]),
    ],
    {
      stdin: Buffer.from(
        buildInstallInput('-----BEGIN CERTIFICATE-----\nBROKER\n-----END CERTIFICATE-----'),
      ),
    },
  );

  expect(install.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, 'imp', 'broker-ca.pem'), 'utf8')).toBe(
    `${rootCertificates.join('\n')}\n\n-----BEGIN CERTIFICATE-----\nBROKER\n-----END CERTIFICATE-----\n`,
  );
});

test('it answers a failed install as not installed, with why, and logs it', async () => {
  const logs: string[] = [];

  const trust = createGuestTrust(
    'input',
    () => Promise.reject(new Error('no sh')),
    (message) => {
      logs.push(message);
    },
  );

  const outcome = await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  expect(outcome).toStrictEqual({ installed: false, detail: 'no sh' });

  expect(logs).toStrictEqual([
    'impd: dev: broker CA not installed, so this exec gets no broker variables: no sh',
  ]);
});

test('it tries a failed install again on the next exec', async () => {
  const install = mock<InstallBundle>(() => Promise.reject(new Error('no sh')));
  const trust = createGuestTrust('input', install, () => {});

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');
  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  expect(install).toHaveBeenCalledTimes(2);
});

test('it keeps a successful install for the rest of the boot', async () => {
  const install = mock<InstallBundle>(() => Promise.resolve());
  const trust = createGuestTrust('input', install, () => {});

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  const again = await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  expect(again).toStrictEqual({ installed: true });
  expect(install).toHaveBeenCalledExactlyOnceWith('/vsock', 'input');
});

test('it runs one install for execs that ask at once', async () => {
  const gate = Promise.withResolvers<void>();
  const install = mock<InstallBundle>(() => gate.promise);
  const trust = createGuestTrust('input', install, () => {});
  const first = trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');
  const second = trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  gate.resolve();

  const outcomes = await Promise.all([first, second]);

  expect(outcomes).toStrictEqual([{ installed: true }, { installed: true }]);
  expect(install).toHaveBeenCalledOnce();
});

test('it installs again for a new pid', async () => {
  const install = mock<InstallBundle>(() => Promise.resolve());
  const trust = createGuestTrust('input', install, () => {});

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');
  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 8 }, '/vsock');

  expect(install).toHaveBeenCalledTimes(2);
});

test('it keeps the install while the imp is seen running on the same pid', async () => {
  const install = mock<InstallBundle>(() => Promise.resolve());
  const trust = createGuestTrust('input', install, () => {});

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  trust.observe({ id: 'imp-1', name: 'dev', pid: 7, state: 'running' });

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  expect(install).toHaveBeenCalledOnce();
});

test('it installs again for the same pid after a stop', async () => {
  const install = mock<InstallBundle>(() => Promise.resolve());
  const trust = createGuestTrust('input', install, () => {});

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  // the stop's write, then a boot that got pid 7 again
  trust.observe({ id: 'imp-1', name: 'dev', pid: null, state: 'stopped' });
  trust.observe({ id: 'imp-1', name: 'dev', pid: 7, state: 'running' });

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  expect(install).toHaveBeenCalledTimes(2);
});

test('it forgets an imp no longer listed, so its next exec installs again', async () => {
  const install = mock<InstallBundle>(() => Promise.resolve());
  const trust = createGuestTrust('input', install, () => {});

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  trust.forgetExcept(new Set(['imp-2']));

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  expect(install).toHaveBeenCalledTimes(2);
});

test('it keeps what it knows of an imp still listed', async () => {
  const install = mock<InstallBundle>(() => Promise.resolve());
  const trust = createGuestTrust('input', install, () => {});

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  trust.forgetExcept(new Set(['imp-1']));

  await trust.ensure({ id: 'imp-1', name: 'dev', pid: 7 }, '/vsock');

  expect(install).toHaveBeenCalledOnce();
});

test('it runs the install as root through the agent with the input on stdin', async () => {
  const ctx = await setupTest();

  const agent = await startStubAgent(
    join(ctx.dir, 'v.sock'),
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
      }

      if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
      }
    },
    { stack: ctx.stack },
  );

  await runBundleInstall(join(ctx.dir, 'v.sock'), 'the bundle input');

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'exec',
    argv: ['/bin/sh', '-c', buildInstallScript()],
    tty: false,
    user: '0',
  });

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.stdin)
      .map((frame) => new TextDecoder().decode(frame.payload)),
  ).toStrictEqual(['the bundle input']);
});

test('it throws with the exit code and stderr of an install that fails', async () => {
  const ctx = await setupTest();

  await startStubAgent(
    join(ctx.dir, 'v.sock'),
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));

        socket.write(
          encodeFrame(FRAME_TYPES.stderr, new TextEncoder().encode('sh: cannot create /etc/imp\n')),
        );

        socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 2, signal: 0 }));
      }
    },
    { stack: ctx.stack },
  );

  expect(runBundleInstall(join(ctx.dir, 'v.sock'), 'input')).rejects.toThrowWithMessage(
    Error,
    'the install exited 2: sh: cannot create /etc/imp',
  );
});

test('it throws when the agent ends the install without an exit', async () => {
  const ctx = await setupTest();

  await startStubAgent(
    join(ctx.dir, 'v.sock'),
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.end(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
      }
    },
    { stack: ctx.stack },
  );

  expect(runBundleInstall(join(ctx.dir, 'v.sock'), 'input')).rejects.toThrowWithMessage(
    Error,
    'the install ended without an exit',
  );
});

test('it cuts off an install that outlasts its timeout', async () => {
  const ctx = await setupTest();

  // the install starts and never exits
  await startStubAgent(
    join(ctx.dir, 'v.sock'),
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
      }
    },
    { stack: ctx.stack },
  );

  expect(
    runBundleInstall(join(ctx.dir, 'v.sock'), 'input', { timeoutMs: 0 }),
  ).rejects.toThrowWithMessage(Error, 'the install did not finish within 0 ms');
});

test('it gives an install 10 seconds to finish', async () => {
  const ctx = await setupTest();

  await startStubAgent(
    join(ctx.dir, 'v.sock'),
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
      }

      if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
      }
    },
    { stack: ctx.stack },
  );

  const startTimer = mock<(cut: () => void, ms: number) => () => void>(() => () => {});

  await runBundleInstall(join(ctx.dir, 'v.sock'), 'input', { startTimer });

  expect(startTimer).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 10_000);
});
