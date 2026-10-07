import { expect, test } from 'bun:test';
import { canUnshare } from './can-unshare';
import { runInNetns } from './run-in-netns';

test.skipIf(!canUnshare(['ip', 'link']))(
  'it runs the script in a network namespace with only a loopback link',
  () => {
    const run = runInNetns({
      script: `ip -o link show | awk -F': ' '{ print $2 }'`,
      env: {},
      mount: false,
    });

    expect(run).toStrictEqual({ stdout: 'lo\n', stderr: '', exitCode: 0 });
  },
);

test.skipIf(!canUnshare(['true']))('it runs the script as root in its namespace', () => {
  const run = runInNetns({ script: 'id -u', env: {}, mount: false });

  expect(run).toStrictEqual({ stdout: '0\n', stderr: '', exitCode: 0 });
});

test.skipIf(!canUnshare(['true']))('it hands the script the env it is given', () => {
  const run = runInNetns({
    script: 'echo "$IMP_NETNS_GREETING"',
    env: { IMP_NETNS_GREETING: 'hello' },
    mount: false,
  });

  expect(run).toStrictEqual({ stdout: 'hello\n', stderr: '', exitCode: 0 });
});

test.skipIf(!canUnshare(['true']))(
  'it reports the stderr and exit code of a failing script',
  () => {
    const run = runInNetns({ script: 'echo broken >&2; exit 3', env: {}, mount: false });

    expect(run).toStrictEqual({ stdout: '', stderr: 'broken\n', exitCode: 3 });
  },
);

test.skipIf(!canUnshare(['true']))('it stops the script at the first failing command', () => {
  const run = runInNetns({ script: 'false\necho reached', env: {}, mount: false });

  expect(run).toStrictEqual({ stdout: '', stderr: '', exitCode: 1 });
});

test.skipIf(!canUnshare(['true']))('it lets the script mount a private /run with mount', () => {
  const run = runInNetns({
    script: 'mount -t tmpfs tmpfs /run\nmkdir -p /run/netns\nip netns add probe\nip netns list',
    env: {},
    mount: true,
  });

  expect(run).toStrictEqual({ stdout: 'probe\n', stderr: '', exitCode: 0 });
});
