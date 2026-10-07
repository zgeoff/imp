import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubHostDocker } from './build-stub-host-docker';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-host-docker-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const owned = stack.move();

  return {
    dir,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it answers the image ids and contract labels of the running and the pulled image', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'unprivileged',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker inspect -f {{.Image}} imp-host; docker image inspect -f {{.Id}} imp-host:next; ' +
        'docker image inspect -f x sha256:old; docker image inspect -f x sha256:new',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('sha256:old\nsha256:new\nunprivileged\nsocket-proxy\n');
});

test('it answers the running image id for the pulled image when that runs already', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
      pulledIsRunning: true,
    }),
  );

  const result = Bun.spawnSync(['docker', 'image', 'inspect', '-f', '{{.Id}}', 'imp-host:next'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('sha256:old\n');
});

test("it prints the pulled image's unit and an empty seccomp profile", () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: "ExecStart=/usr/bin/docker run 'quoted' imp-host\n",
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker run --rm imp-host:next cat /deploy/imp-host.service; ' +
        'docker run --rm imp-host:next cat /deploy/imp-host.seccomp.json',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe("ExecStart=/usr/bin/docker run 'quoted' imp-host\n{}\n");
});

test('it fails to print the deploy file it is told cannot be read', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: '',
      pulledLabel: 'unprivileged',
      pulledUnit: 'unit',
      unreadableFile: '.service',
    }),
  );

  const result = Bun.spawnSync(
    ['docker', 'run', '--rm', 'imp-host:next', 'cat', '/deploy/imp-host.service'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});

test('it prints the compose config and logs the variables compose saw', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
      composeConfig: 'IMP_HOST_IMAGE=imp-host:pinned\n',
    }),
  );

  const result = Bun.spawnSync(['docker', 'compose', '-f', 'c.yaml', 'config', '--environment'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`, IMP_DOCKER_GID: '4242' },
  });

  expect(result.stdout.toString()).toBe('IMP_HOST_IMAGE=imp-host:pinned\n');

  expect(readFileSync(docker.calls, 'utf8')).toBe(
    'docker compose -f c.yaml config --environment\n' +
      'compose config, IMP_HOST_IMAGE unset, IMP_DOCKER_GID 4242\n',
  );
});

test('it fails compose config, after printing its error, as an old Compose does', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
      composeConfigError: 'unknown flag: --environment\n',
    }),
  );

  const result = Bun.spawnSync(['docker', 'compose', '-f', 'c.yaml', 'config', '--environment'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'unknown flag: --environment\n',
    stderr: 'unknown flag: --environment\n',
  });
});

test('it fails a call that upgrade.sh does not make', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['docker', 'system', 'prune'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'unexpected: docker system prune\n',
  });
});

test('it lists the awake imps as running, and sleeps each but the sleepless one', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
      awakeImps: ['web', 'db'],
      sleeplessImp: 'db',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker exec imp-host imp ls --json; docker exec imp-host imp sleep web; echo "web $?"; ' +
        'docker exec imp-host imp sleep db; echo "db $?"',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe(
    '[{"name":"web","state":"running"},{"name":"db","state":"running"}]\nweb 0\ndb 1\n',
  );
});

test('it lists no imps when none are awake', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['docker', 'exec', 'imp-host', 'imp', 'ls', '--json'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('[]\n');
});

test('it answers inspect, pull, plain imp ls and compose up with success and no output', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker inspect imp-host; echo "inspect $?"; docker pull -q imp-host:next; echo "pull $?"; ' +
        'docker exec imp-host imp ls; echo "ls $?"; ' +
        'docker compose -f c.yaml up -d imp-host; echo "up $?"',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('inspect 0\npull 0\nls 0\nup 0\n');
});

test('it fails a pull of another image than the one it was given', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['docker', 'pull', '-q', 'imp-host:other'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(1);
});

test('it answers imp info with an empty object unless told otherwise', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
    }),
  );

  const result = Bun.spawnSync(['docker', 'exec', 'imp-host', 'imp', 'info', '--json'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('{}\n');
});

test('it answers imp info with what it was given', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
      impInfo: '{"bootStatus":null}',
    }),
  );

  const result = Bun.spawnSync(['docker', 'exec', 'imp-host', 'imp', 'info', '--json'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.stdout.toString()).toBe('{"bootStatus":null}\n');
});

test('it fails imp info when told to', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'unit',
      impInfo: null,
    }),
  );

  const result = Bun.spawnSync(['docker', 'exec', 'imp-host', 'imp', 'info', '--json'], {
    env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: '',
  });
});
