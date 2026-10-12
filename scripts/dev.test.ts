import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubDevDocker } from './test-utils/build-stub-dev-docker';
import { buildStubDevHostDocker } from './test-utils/build-stub-dev-host-docker';
import { createStubBin } from './test-utils/create-stub-bin';
import { runSourcedFunction } from './test-utils/run-sourced-function';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-dev-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('it refuses IMP_DEV_PUBLISH=0 without IMP_DEV_IP before it asks docker anything', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'token'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`, IMP_DEV_PUBLISH: '0' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: IMP_DEV_PUBLISH=0 needs IMP_DEV_IP\n',
  });

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it refuses an unknown command with its usage and exit 2', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'start'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr: `usage: ${new URL('dev.sh', import.meta.url).pathname} up|down|reboot|logs|restart|shell|token|prune\n`,
  });
});

test('it refuses a restart when the container is not running', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true, hasSocket: true }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`, IMP_DEV_DATA: ctx.dir },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: imp-dev is not running; use scripts/dev.sh up\n',
  });
});

test('it fails a restart whose new proxy stops without a socket, printing its log', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true, 'imp-dev-docker-proxy': false },
      hasImage: true,
      hasSocket: false,
      logs: { 'imp-dev-docker-proxy': 'proxy: listen EACCES /run/imp-docker/docker.sock\n' },
    }),
  );

  // the group of the docker socket, which a host without Docker lacks
  createStubBin(ctx.dir, 'stat', 'echo 999');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'dev.sh: imp-dev-docker-proxy has no socket; last log lines:\nproxy: listen EACCES /run/imp-docker/docker.sock\n',
  });
});

test('it fails a restart whose impd is not ready by IMP_DEV_READY_TIMEOUT_S', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true, 'imp-dev-docker-proxy': true },
      hasImage: true,
      hasSocket: true,
    }),
  );

  // impd answers /health, but never ready
  createStubBin(ctx.dir, 'curl', `echo '{"ready":false}'`);

  // the group of the docker socket, which a host without Docker lacks
  createStubBin(ctx.dir, 'stat', 'echo 999');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_READY_TIMEOUT_S: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: impd not ready after 1s\n',
  });
});

test('it finishes a restart under IMP_DEV_READY_TIMEOUT_S once impd reports ready', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true, 'imp-dev-docker-proxy': true },
      hasImage: true,
      hasSocket: true,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  // the group of the docker socket, which a host without Docker lacks
  createStubBin(ctx.dir, 'stat', 'echo 999');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_READY_TIMEOUT_S: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it fails a restart whose old impd does not exit by IMP_DEV_STOP_TIMEOUT_S', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true, 'imp-dev-docker-proxy': true },
      hasImage: true,
      hasSocket: true,
      impdPids: [4242],
      impdExits: false,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  // the group of the docker socket, which a host without Docker lacks
  createStubBin(ctx.dir, 'stat', 'echo 999');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_STOP_TIMEOUT_S: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: impd 4242 did not exit\n',
  });
});

test('it finishes a restart under IMP_DEV_STOP_TIMEOUT_S once the old impd exits', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': true, 'imp-dev-docker-proxy': true },
      hasImage: true,
      hasSocket: true,
      impdPids: [4242],
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  // the group of the docker socket, which a host without Docker lacks
  createStubBin(ctx.dir, 'stat', 'echo 999');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'restart'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_DEV_STOP_TIMEOUT_S: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });

  expect(readFileSync(docker.calls, 'utf8')).toInclude('docker exec imp-dev kill -HUP 4242\n');
});

test('it refuses up without a kernel before it asks docker anything', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),
      IMP_KERNEL: join(ctx.dir, 'vmlinux'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: no kernel at ${join(ctx.dir, 'vmlinux')}\n`,
  });

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it refuses up with IMP_HOST_IMAGE_READY=1 when there is no host image', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: false, hasSocket: true }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),

      // a file under the repo stands in for the kernel and the system drive
      IMP_KERNEL: new URL('../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: IMP_HOST_IMAGE_READY=1 but there is no imp-host:dev-test image\n',
  });
});

test('it refuses up without the system drive IMP_SYSTEM_DRIVE names', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({ containers: {}, hasImage: true, hasSocket: true }),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),

      // a file under the repo stands in for the kernel
      IMP_KERNEL: new URL('../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: join(ctx.dir, 'imp-system.squashfs'),
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: no system drive at ${join(ctx.dir, 'imp-system.squashfs')}\n`,
  });
});

test('it refuses up with IMP_TAILNET_NAMES=1 when 1Password has no OAuth client', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev-docker-proxy': true },
      hasImage: true,
      hasSocket: true,
    }),
  );

  // 1Password without the item
  createStubBin(ctx.dir, 'op', 'exit 1');

  // the group of the docker socket, which a host without Docker lacks
  createStubBin(ctx.dir, 'stat', 'echo 999');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),

      // a file under the repo stands in for the kernel and the system drive
      IMP_KERNEL: new URL('../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_TAILNET_NAMES: '1',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'dev.sh: IMP_TAILNET_NAMES=1 but 1Password has no OAuth client\n',
  });

  expect(readFileSync(docker.calls, 'utf8')).not.toInclude('docker run -d --name imp-dev ');
});

test('it passes the Tailscale key to docker by name only in up, and never traces it', () => {
  const ctx = setupTest();

  // the proxy's compile writes its binary into the data dir, and its run
  // passes; every other run and inspect fails, so up stops right at the
  // container start, after building its argv
  const docker = createStubBin(
    ctx.dir,
    'docker',
    [
      'case "$*" in *imp-docker-proxy.new) : > "$IMP_DEV_DATA/imp-docker-proxy.new"; exit 0 ;; esac',
      'case "$*" in *bin/imp-docker-proxy) exit 0 ;; esac',
      'case "$1" in run|inspect) exit 1 ;; esac',
      'exit 0',
    ].join('\n'),
  );

  const result = Bun.spawnSync(['bash', '-x', new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      HOME: ctx.dir,
      TAILSCALE_AUTHKEY: 'fake-tskey-for-the-trace-check',
      IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
      IMP_DEV_NAME: 'imp-dev-trace-check',
      IMP_DEV_DATA: join(ctx.dir, 'data'),
      IMP_HOST_IMAGE_READY: '1',

      // a file under the repo stands in for the kernel and the system drive
      IMP_KERNEL: new URL('../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../package.json', import.meta.url).pathname,
    },
  });

  const trace = result.stderr.toString();

  expect(result.exitCode).not.toBe(0);
  expect(trace).toContain('-e TAILSCALE_AUTHKEY ');
  expect(trace).toContain('-e IMP_TAILSCALE_TAGS=tag:imp-e2e');
  expect(trace).not.toContain('fake-tskey-for-the-trace-check');
});

test('it refuses up with an IMP_ACME_CA_FILE outside the repo', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev-docker-proxy': true },
      hasImage: true,
      hasSocket: true,
    }),
  );

  // the group of the docker socket, which a host without Docker lacks
  createStubBin(ctx.dir, 'stat', 'echo 999');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),

      // a file under the repo stands in for the kernel and the system drive
      IMP_KERNEL: new URL('../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_ACME_CA_FILE: join(ctx.dir, 'pebble-ca.pem'),
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: `dev.sh: ${join(ctx.dir, 'pebble-ca.pem')} is not under ${new URL('..', import.meta.url).pathname.replace(/\/$/u, '')}\n`,
  });

  expect(readFileSync(docker.calls, 'utf8')).not.toInclude('docker run -d --name imp-dev ');
});

test('it fails up when the container stops before impd is ready, printing its log', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevHostDocker({
      containers: { 'imp-dev': false, 'imp-dev-docker-proxy': true },
      hasImage: true,
      hasSocket: true,
      logs: { 'imp-dev': 'impd: /dev/kvm is missing\n' },
    }),
  );

  // impd's /health does not answer
  createStubBin(ctx.dir, 'curl', 'exit 7');

  // the group of the docker socket, which a host without Docker lacks
  createStubBin(ctx.dir, 'stat', 'echo 999');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'up'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_DEV_DATA: join(ctx.dir, 'data'),

      // a file under the repo stands in for the kernel and the system drive
      IMP_KERNEL: new URL('../package.json', import.meta.url).pathname,
      IMP_SYSTEM_DRIVE: new URL('../package.json', import.meta.url).pathname,
      IMP_HOST_IMAGE: 'imp-host:dev-test',
      IMP_HOST_IMAGE_READY: '1',
      IMP_DEV_TAILNET: '0',
      IMP_UPLINK_MTU: '1500',
    },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'dev.sh: started imp-dev\n',
    stderr: 'dev.sh: imp-dev stopped; last log lines:\nimpd: /dev/kvm is missing\n',
  });
});

test('it stops before it asks docker anything when there is no machine id', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', 'exit 1');

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'no-machine-id'),
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    `dev.sh: prune needs a machine id in ${join(ctx.dir, 'no-machine-id')}\n`,
  );

  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it removes the own tag of a gone checkout on this machine, then the leftovers', () => {
  const ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const gone = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'gone')],
  });

  const tag = gone.stdout.trim();

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      {
        tag,
        id: 'id-gone',
        labels: { worktree: join(ctx.dir, 'gone'), machine: 'fake-machine-id' },
      },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString()).toBe(
    `dev.sh: removed ${tag} (${join(ctx.dir, 'gone')} is gone)\n`,
  );

  expect(
    readFileSync(docker.calls, 'utf8')
      .split('\n')
      .filter((call) => /^docker image (?:rm|prune) /u.test(call)),
  ).toStrictEqual([
    `docker image rm ${tag}`,
    'docker image prune -f --filter label=imp.worktree --filter label=imp.machine=fake-machine-id',
  ]);
});

test("it never removes a live checkout's image, another machine's, or an unmarked one", () => {
  const ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const live = runSourcedFunction({ script: lib, fn: 'dev_image_tag', args: [ctx.dir] });

  const other = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'other')],
  });

  const bare = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'unmarked')],
  });

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      {
        tag: live.stdout.trim(),
        id: 'id-live',
        labels: { worktree: ctx.dir, machine: 'fake-machine-id' },
      },
      {
        tag: other.stdout.trim(),
        id: 'id-other',
        labels: { worktree: join(ctx.dir, 'other'), machine: 'another-machine' },
      },
      {
        tag: bare.stdout.trim(),
        id: 'id-unmarked',
        labels: { worktree: join(ctx.dir, 'unmarked'), machine: '' },
      },
      {
        tag: 'imp-host:dev-empty-4',
        id: 'id-empty',
        labels: { worktree: '', machine: 'fake-machine-id' },
      },
      { tag: '<none>:<none>', id: 'id-dangling', labels: null },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe('');

  expect(
    readFileSync(docker.calls, 'utf8')
      .split('\n')
      .filter((call) => /^docker (?:image rm|ps) /u.test(call)),
  ).toStrictEqual([]);
});

test('it keeps a gone checkout image it cannot remove, and says why', () => {
  const ctx = setupTest();

  const lib = new URL('lib.sh', import.meta.url).pathname;

  const stuck = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'stuck')],
  });

  const used = runSourcedFunction({
    script: lib,
    fn: 'dev_image_tag',
    args: [join(ctx.dir, 'used')],
  });

  writeFileSync(join(ctx.dir, 'machine-id'), 'fake-machine-id\n');

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubDevDocker([
      {
        tag: stuck.stdout.trim(),
        id: 'id-stuck',
        labels: { worktree: join(ctx.dir, 'stuck'), machine: 'fake-machine-id' },
        isStuck: true,
      },
      {
        tag: 'imp-host:pinned',
        id: 'id-pinned',
        labels: { worktree: join(ctx.dir, 'stuck'), machine: 'fake-machine-id' },
      },
      {
        tag: used.stdout.trim(),
        id: 'id-used',
        labels: { worktree: join(ctx.dir, 'used'), machine: 'fake-machine-id' },
        container: 'c0ffee',
      },
      { tag: 'imp-host:dev-broken-5', id: 'id-broken', labels: null },
    ]),
  );

  const result = Bun.spawnSync([new URL('dev.sh', import.meta.url).pathname, 'prune'], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_MACHINE_ID_FILE: join(ctx.dir, 'machine-id'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(result.stdout.toString().split('\n')).toStrictEqual([
    `dev.sh: keeping ${stuck.stdout.trim()}: docker image rm failed`,
    `dev.sh: keeping imp-host:pinned: not the tag of ${join(ctx.dir, 'stuck')}`,
    `dev.sh: keeping ${used.stdout.trim()}: a container uses it`,
    'dev.sh: keeping imp-host:dev-broken-5: docker image inspect failed',
    '',
  ]);
});
