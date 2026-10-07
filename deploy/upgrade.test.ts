import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod';
import { buildStubHostDocker } from '../scripts/test-utils/build-stub-host-docker';
import { createStubBin } from '../scripts/test-utils/create-stub-bin';

// upgrade.sh against stub docker, systemctl and curl, with the host's files in a temp dir; the
// calls log holds every docker and systemctl call in order. The child gets only what
// upgrade.sh needs, never this process's tokens.
function setupTest() {
  using stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'imp-upgrade-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // upgrade.sh restarts the units through systemctl
  createStubBin(dir, 'systemctl');

  const owned = stack.move();

  return {
    dir,
    [Symbol.dispose]: () => {
      owned.dispose();
    },
  };
}

test('it installs the unprivileged host unit before the restart, on an upgrade from the privileged host', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: '',
      pulledLabel: 'unprivileged',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --init --privileged imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
  );

  expect(readFileSync(join(ctx.dir, 'imp-host.seccomp.json'), 'utf8')).toBe('{}\n');
  expect(calls).toInclude('systemctl daemon-reload\nsystemctl restart imp-host\n');
  expect(output).toInclude('predates this host contract (unprivileged): to roll back');
  expect(existsSync(join(ctx.dir, 'imp-docker-proxy.service'))).toBeFalse();
});

test('it installs both units, then restarts the proxy before imp-host, on an upgrade from the socket host', () => {
  using ctx = setupTest();

  // a #75 unit: unprivileged, with the host's docker.sock
  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'unprivileged',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -v /var/run/docker.sock:/var/run/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
  );

  expect(readFileSync(join(ctx.dir, 'imp-docker-proxy.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
  );

  expect(calls).toInclude(
    'systemctl daemon-reload\nsystemctl enable -q imp-docker-proxy\n' +
      'systemctl restart imp-docker-proxy\nsystemctl restart imp-host\n',
  );

  expect(output).toInclude('run deploy/bootstrap.sh of its release');
});

test('it tells how to roll back by restarting both units, on an upgrade between proxy hosts', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode).toBe(0);
  expect(output).toInclude('then systemctl restart imp-docker-proxy imp-host');
});

test('it refuses a rollback past the socket proxy before anything changes', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'unprivileged',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('predates the Docker socket proxy');

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  expect(calls).not.toInclude('systemctl');
  expect(calls).not.toInclude('imp sleep');
});

test("it starts imp-host alone, with a NOTE, under a compose file that gives imp-host the host's socket", () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'unprivileged',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -v /var/run/docker.sock:/var/run/docker.sock imp-host\n',
  );

  writeFileSync(
    join(ctx.dir, 'compose.yaml'),
    'services:\n  imp-host:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n',
  );

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toMatch(/docker compose -f \S+ up -d imp-host\n/v);
  expect(output).toInclude("still gives imp-host the host's docker.sock");
});

test('it starts the proxy service with imp-host under a compose file that has it', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(
    join(ctx.dir, 'compose.yaml'),
    'services:\n  imp-docker-proxy:\n    image: x\n  imp-host:\n' +
      '    environment:\n      DOCKER_HOST: unix:///run/imp-docker/docker.sock\n',
  );

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toMatch(/docker compose -f \S+ up -d imp-docker-proxy imp-host\n/v);
  expect(output).not.toInclude('NOTE: ');
});

test('it refuses a rollback past the unprivileged host before anything changes', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'unprivileged',
      pulledLabel: '',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('run deploy/bootstrap.sh of that');

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
  );

  expect(calls).not.toInclude('systemctl');
  expect(calls).not.toInclude('imp sleep');
});

test('it keeps the compose file, and says it still runs privileged, on an upgrade to the unprivileged host', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: '',
      pulledLabel: 'unprivileged',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --init --privileged imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    privileged: true\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --init --privileged imp-host\n',
  );

  expect(readFileSync(join(ctx.dir, 'imp-host.seccomp.json'), 'utf8')).toBe('{}\n');
  expect(calls).toInclude('docker compose -f');
  expect(output).toInclude('still runs privileged');
});

test('it stops before any imp sleeps when the image cannot give its unit', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: '',
      pulledLabel: 'unprivileged',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
      unreadableFile: '.service',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --init --privileged imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('cannot read');

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --init --privileged imp-host\n',
  );

  expect(existsSync(join(ctx.dir, 'imp-host.seccomp.json'))).toBeFalse();
  expect(readdirSync(ctx.dir).filter((file) => file.endsWith('.new'))).toBeEmpty();
  expect(calls).not.toInclude('imp ls');
  expect(calls).not.toInclude('systemctl');
});

test('it stops before the restart when a unit cannot be installed', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: '',
      pulledLabel: 'unprivileged',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);
  createStubBin(ctx.dir, 'mv', `echo 'mv: cannot move' >&2; exit 1`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --init --privileged imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('cannot install');
  expect(output).not.toInclude('installed');

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --init --privileged imp-host\n',
  );

  expect(readdirSync(ctx.dir).filter((file) => file.endsWith('.new'))).toBeEmpty();
  expect(calls).not.toInclude('systemctl');
});

test('it moves to its own release when no image is named', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: release,
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude(`docker pull -q ${release}\n`);
  expect(existsSync(join(ctx.dir, 'imp-host.env'))).toBeFalse();
});

test("it moves to the env file's pin over its own release", () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:pinned',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_PORT=7070\nIMP_HOST_IMAGE=imp-host:pinned\n', {
    mode: 0o600,
  });

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude('docker pull -q imp-host:pinned\n');

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    'IMP_PORT=7070\nIMP_HOST_IMAGE=imp-host:pinned\n',
  );

  expect(
    readdirSync(ctx.dir).filter((file) => /^imp-host\.env\.bak-\d{8}-\d{6}$/v.test(file)),
  ).toBeEmpty();
});

test('it comments out the old template line, which is no pin, with a .bak of the file', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: release,
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(
    join(ctx.dir, 'imp-host.env'),
    'TAILSCALE_AUTHKEY=fake-key-for-tests\nIMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\nIMP_PORT=7070\n',
    { mode: 0o600 },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  const backups = readdirSync(ctx.dir).filter((file) =>
    /^imp-host\.env\.bak-\d{8}-\d{6}$/v.test(file),
  );

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude(`docker pull -q ${release}\n`);

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    `TAILSCALE_AUTHKEY=fake-key-for-tests\n# IMP_HOST_IMAGE=${release}\nIMP_PORT=7070\n`,
  );

  expect(backups.map((file) => readFileSync(join(ctx.dir, file), 'utf8'))).toStrictEqual([
    'TAILSCALE_AUTHKEY=fake-key-for-tests\nIMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\nIMP_PORT=7070\n',
  ]);

  expect(
    ['imp-host.env', ...backups].map((file) => statSync(join(ctx.dir, file)).mode & 0o777),
  ).toStrictEqual([0o600, 0o600]);

  expect(output).toInclude('was the old template');
  expect(readdirSync(ctx.dir).filter((file) => file.endsWith('.new'))).toBeEmpty();
});

test('it refuses an image from the environment that the units would not run, before any imp sleeps', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n', {
    mode: 0o600,
  });

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(output).toInclude(
    `imp-host.service would run ${release}, not ghcr.io/zgeoff/imp-host:next`,
  );

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
  );

  expect(readdirSync(ctx.dir).filter((file) => file.endsWith('.new'))).toBeEmpty();
  expect(calls).not.toInclude('imp ls');
  expect(calls).not.toInclude('systemctl');
});

test('it writes the image to the .env beside the compose file, with a .bak', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(
    join(ctx.dir, 'compose.yaml'),
    'services:\n  imp-docker-proxy:\n    image: x\n  imp-host:\n' +
      '    environment:\n      DOCKER_HOST: unix:///run/imp-docker/docker.sock\n',
  );

  writeFileSync(
    join(ctx.dir, '.env'),
    'IMP_DOCKER_GID=999\nIMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:0.1.0\n',
  );

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const output = result.stdout.toString() + result.stderr.toString();
  const backups = readdirSync(ctx.dir).filter((file) => /^\.env\.bak-\d{8}-\d{6}$/v.test(file));

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, '.env'), 'utf8')).toBe(
    'IMP_DOCKER_GID=999\nIMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:next\n',
  );

  expect(backups.map((file) => readFileSync(join(ctx.dir, file), 'utf8'))).toStrictEqual([
    'IMP_DOCKER_GID=999\nIMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:0.1.0\n',
  ]);

  expect(backups.map((file) => statSync(join(ctx.dir, file)).mode & 0o777)).toStrictEqual([0o600]);

  expect(output).toInclude(
    `wrote IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:next to ${join(ctx.dir, '.env')}`,
  );

  expect(output).toInclude(`(the file before: ${join(ctx.dir, '.env.bak-')}`);
});

test('it writes a .env that names the image beside a compose file without one', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, '.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:next\n',
  );

  expect(readdirSync(ctx.dir).filter((file) => /^\.env\.bak-\d{8}-\d{6}$/v.test(file))).toBeEmpty();
});

test('it refuses the image of a drop-in for imp-host alone, as the proxy unit would run another', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  mkdirSync(join(ctx.dir, 'imp-host.service.d'));

  writeFileSync(
    join(ctx.dir, 'imp-host.service.d', 'image.conf'),
    '[Service]\nEnvironment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:next\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude(`imp-docker-proxy.service would run ${release}`);
  expect(calls).not.toInclude('systemctl');
});

test("it counts a drop-in's image as its unit's own, for imp-host and the proxy alike", () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  mkdirSync(join(ctx.dir, 'imp-host.service.d'));

  writeFileSync(
    join(ctx.dir, 'imp-host.service.d', 'image.conf'),
    '[Service]\nEnvironment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:next\n',
  );

  mkdirSync(join(ctx.dir, 'imp-docker-proxy.service.d'));

  writeFileSync(
    join(ctx.dir, 'imp-docker-proxy.service.d', 'image.conf'),
    '[Service]\nEnvironment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:next\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude('systemctl restart imp-host\n');
});

test('it reads the unit image from a quoted Environment= line that sets several variables', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment="IMP_X=1" "IMP_HOST_IMAGE=${release}"\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode).toBe(1);

  expect(output).toInclude(
    `imp-host.service would run ${release}, not ghcr.io/zgeoff/imp-host:next`,
  );
});

test('it takes the release-please marker lines out of the units it installs', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: release,
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `# x-release-please-start-version\nEnvironment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n# x-release-please-end\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
  );
});

test('it migrates the old template line with a CR and blanks around it', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: release,
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(
    join(ctx.dir, 'imp-host.env'),
    'IMP_PORT=7070\r\n  IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest \r\n',
    { mode: 0o600 },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude(`docker pull -q ${release}\n`);

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    `IMP_PORT=7070\r\n# IMP_HOST_IMAGE=${release}\n`,
  );
});

test('it migrates a quoted old template line too', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: release,
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(
    join(ctx.dir, 'imp-host.env'),
    'IMP_PORT=7070\nIMP_HOST_IMAGE="ghcr.io/zgeoff/imp-host:latest"\n',
    { mode: 0o600 },
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude(`docker pull -q ${release}\n`);

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    `IMP_PORT=7070\n# IMP_HOST_IMAGE=${release}\n`,
  );
});

test('it keeps the pin in the compose .env and moves to that image', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:pinned',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');
  writeFileSync(join(ctx.dir, '.env'), 'IMP_DOCKER_GID=999\nIMP_HOST_IMAGE="imp-host:pinned"\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: '',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude('docker pull -q imp-host:pinned\n');

  expect(readFileSync(join(ctx.dir, '.env'), 'utf8')).toBe(
    'IMP_DOCKER_GID=999\nIMP_HOST_IMAGE="imp-host:pinned"\n',
  );

  expect(readdirSync(ctx.dir).filter((file) => /^\.env\.bak-\d{8}-\d{6}$/v.test(file))).toBeEmpty();
});

test('it still writes the image lines and units, without a restart, on a systemd host that runs the image already', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: release,
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
      pulledIsRunning: true,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    `Environment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
  );

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n', {
    mode: 0o600,
  });

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(output).toInclude('already runs');
  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(`# IMP_HOST_IMAGE=${release}\n`);

  expect(
    readdirSync(ctx.dir)
      .filter((file) => /^imp-host\.env\.bak-\d{8}-\d{6}$/v.test(file))
      .map((file) => readFileSync(join(ctx.dir, file), 'utf8')),
  ).toStrictEqual(['IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n']);

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
  );

  expect(readFileSync(join(ctx.dir, 'imp-docker-proxy.service'), 'utf8')).toBe(
    `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
  );

  expect(calls).toInclude('systemctl daemon-reload\n');
  expect(calls).not.toInclude('restart');
  expect(calls).not.toInclude('imp ls');
});

test('it still writes the compose .env, without compose up, on a compose host that runs the image already', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
      pulledIsRunning: true,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);

  expect(readFileSync(join(ctx.dir, '.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:next\n',
  );

  expect(calls).not.toInclude('compose');
});

test('it refuses an env file that sets IMP_HOST_IMAGE empty before anything changes', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_PORT=7070\nIMP_HOST_IMAGE=\n', { mode: 0o600 });

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('imp-host.env sets IMP_HOST_IMAGE= empty');

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    'IMP_PORT=7070\nIMP_HOST_IMAGE=\n',
  );

  expect(calls.split('\n').filter((call) => call.startsWith('docker pull '))).toBeEmpty();
  expect(calls).not.toInclude('systemctl');
});

test('it refuses a host that runs the image already when its units would run another', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const release = `ghcr.io/zgeoff/imp-host:${z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version}`;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: `Environment=IMP_HOST_IMAGE=${release}\nExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n`,
      pulledIsRunning: true,
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n', {
    mode: 0o600,
  });

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(output).toInclude(
    `imp-host.service would run ${release}, not ghcr.io/zgeoff/imp-host:next`,
  );

  expect(readFileSync(join(ctx.dir, 'imp-host.service'), 'utf8')).toBe(
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
  );

  expect(calls).not.toInclude('systemctl');
});

test("it reads the compose .env's image through docker compose config, with the shell's unset", () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:pinned',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
      composeConfig: 'PATH=/bin\nREGISTRY=imp-host\nIMP_HOST_IMAGE=imp-host:pinned\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');

  writeFileSync(
    join(ctx.dir, '.env'),
    `REGISTRY=imp-host\nIMP_HOST_IMAGE=\${REGISTRY}:pinned # mine\n`,
  );

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_DOCKER_GID: '4242',
        IMP_HOST_IMAGE: '',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude('compose config, IMP_HOST_IMAGE unset, IMP_DOCKER_GID 4242\n');
  expect(calls).toInclude('docker pull -q imp-host:pinned\n');

  expect(readFileSync(join(ctx.dir, '.env'), 'utf8')).toBe(
    `REGISTRY=imp-host\nIMP_HOST_IMAGE=\${REGISTRY}:pinned # mine\n`,
  );

  expect(readdirSync(ctx.dir).filter((file) => /^\.env\.bak-\d{8}-\d{6}$/v.test(file))).toBeEmpty();
});

test('it leaves a trailing comment out of the compose .env image without compose config', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:pinned',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');
  writeFileSync(join(ctx.dir, '.env'), 'IMP_HOST_IMAGE=imp-host:pinned # mine\r\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: '',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude('docker pull -q imp-host:pinned\n');

  expect(readFileSync(join(ctx.dir, '.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=imp-host:pinned # mine\r\n',
  );
});

test('it refuses a compose .env image built from other variables, before any pull, without compose config', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');
  writeFileSync(join(ctx.dir, '.env'), `REGISTRY=imp-host\nIMP_HOST_IMAGE="\${REGISTRY}:pinned"\n`);

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: '',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);
  expect(output).toInclude('sets IMP_HOST_IMAGE from other variables');
  expect(calls.split('\n').filter((call) => call.startsWith('docker pull '))).toBeEmpty();

  expect(readFileSync(join(ctx.dir, '.env'), 'utf8')).toBe(
    `REGISTRY=imp-host\nIMP_HOST_IMAGE="\${REGISTRY}:pinned"\n`,
  );
});

test('it gives compose config an IMP_DOCKER_GID when the environment has none', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:pinned',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
      composeConfig: 'IMP_HOST_IMAGE=imp-host:pinned\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');
  writeFileSync(join(ctx.dir, '.env'), 'IMP_HOST_IMAGE=imp-host:pinned\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: '',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toMatch(/compose config, IMP_HOST_IMAGE unset, IMP_DOCKER_GID \d*\n/v);
});

test('it never prints the environment that compose config reads', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:pinned',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
      composeConfig: 'SECRET=hunter2\nIMP_HOST_IMAGE=imp-host:pinned\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');
  writeFileSync(join(ctx.dir, '.env'), 'IMP_HOST_IMAGE=imp-host:pinned\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: '',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode).toBe(0);
  expect(output).not.toInclude('hunter2');
});

test('it never prints what a failing compose config prints, and reads the .env itself', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'imp-host:pinned',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit: 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n',
      composeConfigError: 'SECRET=hunter2\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'compose.yaml'), 'services:\n  imp-host:\n    image: x\n');
  writeFileSync(join(ctx.dir, '.env'), 'IMP_HOST_IMAGE=imp-host:pinned\n');

  const result = Bun.spawnSync(
    [
      'bash',
      new URL('upgrade.sh', import.meta.url).pathname,
      '--compose',
      join(ctx.dir, 'compose.yaml'),
    ],
    {
      env: {
        PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: '',
        IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
        IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
        IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
        IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      },
    },
  );

  const output = result.stdout.toString() + result.stderr.toString();
  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(calls).toInclude('docker pull -q imp-host:pinned\n');
  expect(output).not.toInclude('hunter2');
});

test('it refuses --compose without a file, with its usage', () => {
  using ctx = setupTest();

  const result = Bun.spawnSync(
    ['bash', new URL('upgrade.sh', import.meta.url).pathname, '--compose'],
    {
      env: { PATH: `${join(ctx.dir, 'bin')}:${process.env['PATH'] ?? ''}` },
    },
  );

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toEndWith(' [--compose <file>]\n');
});

test('it refuses to run on a host without jq', () => {
  using ctx = setupTest();

  const docker = createStubBin(ctx.dir, 'docker');

  createStubBin(ctx.dir, 'curl');

  const result = Bun.spawnSync(
    [Bun.which('bash') ?? 'bash', new URL('upgrade.sh', import.meta.url).pathname],
    {
      env: { PATH: docker.bin },
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe('upgrade: jq is not installed\n');
  expect(readFileSync(docker.calls, 'utf8')).toBe('');
});

test('it refuses a host with no imp-host container, before any pull', () => {
  using ctx = setupTest();

  const docker = createStubBin(ctx.dir, 'docker', 'exit 1');

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toBe(
    'upgrade: no imp-host container; start the host first (docs/guides/install.md)\n',
  );

  expect(readFileSync(docker.calls, 'utf8')).toBe('docker inspect imp-host\n');
});

test('it sleeps each awake imp before the restart', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit:
        'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
      awakeImps: ['web', 'db'],
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toInclude('upgrade: web asleep\nupgrade: db asleep\n');

  expect(
    calls
      .split('\n')
      .filter((call) => /^(?:docker exec imp-host imp sleep|systemctl restart) /v.test(call)),
  ).toStrictEqual([
    'docker exec imp-host imp sleep web',
    'docker exec imp-host imp sleep db',
    'systemctl restart imp-docker-proxy',
    'systemctl restart imp-host',
  ]);
});

test('it stops before anything restarts when an imp does not sleep', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit:
        'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
      awakeImps: ['web', 'db'],
      sleeplessImp: 'db',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  const calls = readFileSync(docker.calls, 'utf8');

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    'upgrade: db did not sleep; the host still runs sha256:old\n',
  );

  expect(calls).not.toInclude('systemctl');
  expect(existsSync(join(ctx.dir, 'imp-docker-proxy.service'))).toBeFalse();
});

test('it fails the upgrade when impd is not ready in time after the restart', () => {
  using ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: 'ghcr.io/zgeoff/imp-host:next',
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit:
        'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":false}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: 'ghcr.io/zgeoff/imp-host:next',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
      IMP_READY_TIMEOUT_S: '0',
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    'upgrade: impd is not ready after 0 s; see: docker logs imp-host\n',
  );

  expect(readFileSync(docker.calls, 'utf8')).toInclude('systemctl restart imp-host\n');
});

test('it stops before anything restarts when it cannot rewrite the env file', () => {
  using ctx = setupTest();

  const pkgText = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const version = z.object({ version: z.string() }).parse(JSON.parse(pkgText)).version;

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubHostDocker({
      image: `ghcr.io/zgeoff/imp-host:${version}`,
      runningLabel: 'socket-proxy',
      pulledLabel: 'socket-proxy',
      pulledUnit:
        `Environment=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:${version}\n` +
        'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
    }),
  );

  createStubBin(ctx.dir, 'curl', `echo '{"ready":true}'`);

  writeFileSync(
    join(ctx.dir, 'imp-host.service'),
    'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n',
  );

  writeFileSync(join(ctx.dir, 'imp-host.env'), 'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n', {
    mode: 0o600,
  });

  // a dangling symlink where the rewrite writes the new file, which cp will not write through
  symlinkSync(join(ctx.dir, 'missing', 'imp-host.env'), join(ctx.dir, 'imp-host.env.new'));

  const result = Bun.spawnSync(['bash', new URL('upgrade.sh', import.meta.url).pathname], {
    env: {
      PATH: `${docker.bin}:${process.env['PATH'] ?? ''}`,
      IMP_HOST_IMAGE: '',
      IMP_HOST_ENV_FILE: join(ctx.dir, 'imp-host.env'),
      IMP_HOST_UNIT_FILE: join(ctx.dir, 'imp-host.service'),
      IMP_DOCKER_PROXY_UNIT_FILE: join(ctx.dir, 'imp-docker-proxy.service'),
      IMP_HOST_SECCOMP_FILE: join(ctx.dir, 'imp-host.seccomp.json'),
    },
  });

  expect(result.exitCode).toBe(1);

  expect(result.stderr.toString()).toInclude(
    `upgrade: cannot rewrite ${join(ctx.dir, 'imp-host.env')}; nothing restarted, the host still runs sha256:old\n`,
  );

  expect(readFileSync(join(ctx.dir, 'imp-host.env'), 'utf8')).toBe(
    'IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest\n',
  );

  expect(readFileSync(docker.calls, 'utf8')).not.toInclude('systemctl');
});
