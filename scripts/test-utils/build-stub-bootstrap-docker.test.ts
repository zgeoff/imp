import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubBootstrapDocker } from './build-stub-bootstrap-docker';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'imp-bootstrap-docker-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    dir,
  };
}

test('it answers the daemon version', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ serverVersion: '27.3.1' }),
  );

  expect(
    Bun.spawnSync([
      join(docker.bin, 'docker'),
      'version',
      '-f',
      '{{.Server.Version}}',
    ]).stdout.toString(),
  ).toBe('27.3.1\n');
});

test('it fails the daemon version when no version is set, as a daemon that is down', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));

  const result = Bun.spawnSync([
    join(docker.bin, 'docker'),
    'version',
    '-f',
    '{{.Server.Version}}',
  ]);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n',
  });
});

test('it answers the imp-host network in any format but the container list', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({
      hostNetwork: 'true br-imphost fd12::/64',
      networkContainers: ['web'],
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      `docker network inspect -f '{{.EnableIPv6}} {{or (index .Options "com.docker.network.bridge.name") "unnamed"}}' imp-host; docker network inspect imp-host`,
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('true br-imphost fd12::/64\ntrue br-imphost fd12::/64\n');
});

test('it answers the containers on the imp-host network, each followed by a blank', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({
      hostNetwork: 'true br-imphost fd12::/64',
      networkContainers: ['imp-host', 'web'],
    }),
  );

  expect(
    Bun.spawnSync([
      join(docker.bin, 'docker'),
      'network',
      'inspect',
      '-f',
      '{{range .Containers}}{{.Name}} {{end}}',
      'imp-host',
    ]).stdout.toString(),
  ).toBe('imp-host web \n');
});

test('it fails each inspect of the imp-host network when there is none', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      "docker network inspect imp-host; echo $?; docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' imp-host; echo $?",
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: '1\n1\n',
    stderr:
      'Error response from daemon: network imp-host not found\nError response from daemon: network imp-host not found\n',
  });
});

test('it inspects an image the host holds and fails one it lacks', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ images: ['imp-host:1'] }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker image inspect imp-host:1; echo $?; docker image inspect imp-host:2; echo $?',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: '0\n1\n',
    stderr: 'Error response from daemon: No such image: imp-host:2\n',
  });
});

test('it loads an archive without adding the image a caller then inspects', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker load -q -i /srv/imp.tar; echo $?; docker image inspect imp-host:1; echo $?',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('0\n1\n');
});

test('it prints the seccomp profile of an image that carries one', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ images: ['imp-host:1'], seccompImages: ['imp-host:1'] }),
  );

  expect(
    Bun.spawnSync([
      join(docker.bin, 'docker'),
      'run',
      '--rm',
      'imp-host:1',
      'cat',
      '/usr/local/share/imp/deploy/imp-host.seccomp.json',
    ]).stdout.toString(),
  ).toBe('{}\n');
});

test('it fails the cat of the seccomp profile in an image without one', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({ images: ['imp-host:1'] }),
  );

  const result = Bun.spawnSync([
    join(docker.bin, 'docker'),
    'run',
    '--rm',
    'imp-host:1',
    'cat',
    '/usr/local/share/imp/deploy/imp-host.seccomp.json',
  ]);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'cat: /usr/local/share/imp/deploy/imp-host.seccomp.json: No such file or directory\n',
  });
});

test('it answers the imp-host container with what each of its fields sets', () => {
  const ctx = setupTest();

  const docker = createStubBin(
    ctx.dir,
    'docker',
    buildStubBootstrapDocker({
      impInfo: '{"storage":{"backend":"xfs"}}',
      published: '7070/tcp -> 127.0.0.1:7070',
      dataMount: 'tank/imp zfs',
      ipv6Route: 'default via fd12::1 dev eth0',
      logs: 'impd: ipv6: on',
    }),
  );

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      'docker exec imp-host impz info; docker exec imp-host impz info --json; docker port imp-host; ' +
        'docker exec imp-host findmnt -n -r -o SOURCE,FSTYPE --mountpoint /var/lib/imp; ' +
        'docker exec imp-host ip -6 route show default; docker logs imp-host',
    ],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe(
    '{"storage":{"backend":"xfs"}}\n{"storage":{"backend":"xfs"}}\n7070/tcp -> 127.0.0.1:7070\n' +
      'tank/imp zfs\ndefault via fd12::1 dev eth0\nimpd: ipv6: on\n',
  );
});

test('it answers the imp-host container with nothing for each field left out', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));

  const result = Bun.spawnSync(
    ['bash', '-c', 'docker port imp-host; docker exec imp-host ip -6 route show default; echo $?'],
    { env: { PATH: `${docker.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.stdout.toString()).toBe('0\n');
});

test('it fails a call bootstrap.sh does not make as unexpected', () => {
  const ctx = setupTest();
  const docker = createStubBin(ctx.dir, 'docker', buildStubBootstrapDocker({}));
  const result = Bun.spawnSync([join(docker.bin, 'docker'), 'ps']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'unexpected: docker ps\n',
  });
});
