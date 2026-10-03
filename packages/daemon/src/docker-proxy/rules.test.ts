import { describe, expect, test } from 'bun:test';
import { parseQuery } from './router';
import {
  checkBuildQuery,
  checkCreateBody,
  checkImageReference,
  checkPullQuery,
  checkRemoveQuery,
  readImageReference,
} from './rules';

const HOST_IMAGE = 'ghcr.io/zgeoff/imp-host:latest';

// the query `docker build` 29.8 sends for each of impd's two build routes
const BUILD_FROM_DIR = 'dockerfile=Dockerfile&q=1&t=imp%2Fx%3Alatest&version=1';

const BUILD_FROM_UPLOAD =
  'buildargs=%7B%22BUILDKIT_SYNTAX%22%3A%22docker%2Fdockerfile%3A1%22%7D&dockerfile=Dockerfile&q=1&t=imp%2Fx%3Alatest&version=1';

// the body `docker create busybox /bin/true` 29.8 sends
const CREATE_BODY = {
  Hostname: '',
  Domainname: '',
  User: '',
  AttachStdin: false,
  AttachStdout: true,
  AttachStderr: true,
  Tty: false,
  OpenStdin: false,
  StdinOnce: false,
  Env: null,
  Cmd: ['/bin/true'],
  Image: 'busybox',
  Volumes: {},
  WorkingDir: '',
  Entrypoint: null,
  OnBuild: null,
  Labels: {},
  HostConfig: {
    Binds: null,
    ContainerIDFile: '',
    LogConfig: { Type: '', Config: {} },
    NetworkMode: 'default',
    PortBindings: {},
    RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    AutoRemove: false,
    VolumeDriver: '',
    VolumesFrom: null,
    ConsoleSize: [0, 0],
    CapAdd: null,
    CapDrop: null,
    Privileged: false,
    Mounts: null,
    Devices: [],
    MemorySwappiness: -1,
  },
  NetworkingConfig: {
    EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
  },
};

function buildArgsQuery(value: Readonly<Record<string, string>>): string {
  return `t=imp%2Fx%3Alatest&version=1&buildargs=${encodeURIComponent(JSON.stringify(value))}`;
}

function checkBuild(raw: string): string {
  const checked = checkBuildQuery(parseQuery(raw));

  return checked.isOk ? 'ok' : checked.reason;
}

function checkCreate(
  patch: Readonly<Record<string, unknown>>,
  hostConfig: Readonly<Record<string, unknown>> = {},
): string {
  const body = {
    ...CREATE_BODY,
    ...patch,
    HostConfig: { ...CREATE_BODY.HostConfig, ...hostConfig },
  };

  const checked = checkCreateBody(body, HOST_IMAGE);

  return checked.isOk ? 'ok' : checked.reason;
}

describe('a build query', () => {
  test('passes as impd sends it, from a directory and from an upload', () => {
    expect(checkBuild(BUILD_FROM_DIR)).toBe('ok');
    expect(checkBuild(BUILD_FROM_UPLOAD)).toBe('ok');
    expect(checkBuild(`${BUILD_FROM_DIR}&rm=1&forcerm=0`)).toBe('ok');
  });

  test('fails with a tag that is not imp/<name>:latest, even as a second -t', () => {
    expect(checkBuild('t=imp-host%3Alatest&version=1')).toContain('param t');

    expect(checkBuild(`${BUILD_FROM_DIR}&t=ghcr.io%2Fzgeoff%2Fimp-host%3Alatest`)).toContain(
      'param t',
    );

    expect(checkBuild('t=imp%2Fx%3Av2&version=1')).toContain('param t');
    expect(checkBuild('version=1')).toBe('param t is missing');
  });

  test('fails without version=1: BuildKit needs a session the proxy refuses', () => {
    expect(checkBuild('t=imp%2Fx%3Alatest')).toBe('param version is missing');
    expect(checkBuild('t=imp%2Fx%3Alatest&version=2')).toBe('param version is "2"');

    expect(checkBuild('t=imp%2Fx%3Alatest&version=1&version=1')).toBe(
      'param version is given 2 times',
    );
  });

  test('fails with a dockerfile outside the context', () => {
    for (const path of [
      '..%2FDockerfile',
      'a%2F..%2F..%2Fb',
      '%2Fetc%2Fpasswd',
      '.%2FDockerfile',
      'a%2F%2Fb',
    ]) {
      expect(checkBuild(`t=imp%2Fx%3Alatest&version=1&dockerfile=${path}`)).toContain(
        'not a path inside the context',
      );
    }

    expect(checkBuild('t=imp%2Fx%3Alatest&version=1&dockerfile=sub%2FDockerfile.dev')).toBe('ok');
  });

  test('fails with a build arg impd does not send, or another syntax frontend', () => {
    expect(checkBuild(buildArgsQuery({ BUILDKIT_SYNTAX: 'evil/frontend:1' }))).toContain(
      'sets BUILDKIT_SYNTAX',
    );

    expect(checkBuild(buildArgsQuery({ HTTP_PROXY: 'http://x' }))).toContain('sets HTTP_PROXY');

    expect(checkBuild('t=imp%2Fx%3Alatest&version=1&buildargs=nope')).toBe(
      'param buildargs is not JSON',
    );
  });

  test('fails with any other param: remote, memory, network, cache, labels', () => {
    for (const extra of [
      'remote=https%3A%2F%2Fx',
      'memory=1',
      'networkmode=host',
      'cachefrom=%5B%5D',
      'labels=%7B%7D',
      'extrahosts=a',
      'session=abc',
      'target=x',
      'outputs=x',
    ]) {
      expect(checkBuild(`${BUILD_FROM_DIR}&${extra}`)).toContain('is not allowed');
    }
  });
});

describe('an image reference', () => {
  test('reads the registry and the repository as the engine does', () => {
    expect(readImageReference('busybox')).toEqual({
      registry: 'docker.io',
      path: 'library/busybox',
    });

    expect(readImageReference('docker.io/library/busybox:1.36')).toEqual({
      registry: 'docker.io',
      path: 'library/busybox',
    });

    expect(readImageReference('ghcr.io/zgeoff/imp-host:latest')).toEqual({
      registry: 'ghcr.io',
      path: 'zgeoff/imp-host',
    });

    expect(readImageReference('localhost:5000/x@sha256:ab')).toEqual({
      registry: 'localhost:5000',
      path: 'x',
    });

    expect(readImageReference('imp-host:dev')).toEqual({
      registry: 'docker.io',
      path: 'library/imp-host',
    });
  });

  test('fails on the host loopback, an IP address or the repository imp-host runs from', () => {
    for (const reference of [
      'localhost/x',
      'localhost:5000/x',
      'reg.localhost/x',
      '127.0.0.1:5000/x',
      '169.254.169.254/x',
      '[::1]:5000/x',
      '[fe80::1]/x',
      'ghcr.io/zgeoff/imp-host:other',
      'ghcr.io/zgeoff/imp-host@sha256:aa',
    ]) {
      expect(checkImageReference(reference, HOST_IMAGE).isOk).toBe(false);
    }

    expect(checkImageReference('imp-host:dev', 'imp-host:dev').isOk).toBe(false);
    expect(checkImageReference('ghcr.io/zgeoff/other:latest', HOST_IMAGE).isOk).toBe(true);
  });
});

describe('a pull query', () => {
  const checkPull = (raw: string): string => {
    const checked = checkPullQuery(parseQuery(raw), HOST_IMAGE);

    return checked.isOk ? 'ok' : checked.reason;
  };

  test('passes as `docker pull` sends it', () => {
    expect(checkPull('fromImage=docker.io%2Flibrary%2Fbusybox&tag=latest')).toBe('ok');
  });

  test('fails with fromSrc, repo or changes, or on a refused registry', () => {
    expect(checkPull('fromSrc=-&repo=x')).toContain('is not allowed');
    expect(checkPull('fromImage=busybox&changes=CMD')).toContain('is not allowed');
    expect(checkPull('fromImage=busybox&tag=a&tag=b')).toBe('param tag is given 2 times');
    expect(checkPull('fromImage=127.0.0.1%3A5000%2Fx&tag=latest')).toContain('IP address');

    expect(checkPull('fromImage=ghcr.io%2Fzgeoff%2Fimp-host&tag=evil')).toContain(
      'imp-host runs from',
    );

    expect(checkPull('tag=latest')).toBe('param fromImage is missing');
  });
});

describe('a remove query', () => {
  test('takes force only', () => {
    expect(checkRemoveQuery(parseQuery('force=1')).isOk).toBe(true);
    expect(checkRemoveQuery(parseQuery('force=1&link=1')).isOk).toBe(false);
  });
});

describe('a create body', () => {
  test('passes as `docker create <image> /bin/true` sends it', () => {
    expect(checkCreate({})).toBe('ok');
    expect(checkCreateBody(CREATE_BODY, HOST_IMAGE)).toEqual({ isOk: true, image: 'busybox' });
  });

  test('fails with another command, an entrypoint, labels, volumes or env', () => {
    expect(checkCreate({ Cmd: ['/bin/sh'] })).toContain('Cmd is');
    expect(checkCreate({ Entrypoint: ['/bin/sh'] })).toBe('Entrypoint is set');
    expect(checkCreate({ Labels: { a: 'b' } })).toBe('Labels is set');
    expect(checkCreate({ Volumes: { '/x': {} } })).toBe('Volumes is set');
    expect(checkCreate({ Env: ['A=1'] })).toBe('Env is set');
    expect(checkCreate({ User: 'root' })).toBe('User is set');
    expect(checkCreate({ AttachStdin: true })).toBe('AttachStdin is set');
  });

  test('fails with any HostConfig key off its default', () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ['Privileged', true],
      ['Binds', ['/:/host']],
      ['Mounts', [{ Type: 'bind', Source: '/', Target: '/host' }]],
      ['CapAdd', ['SYS_ADMIN']],
      ['Devices', [{ PathOnHost: '/dev/kvm' }]],
      ['NetworkMode', 'host'],
      ['PidMode', 'host'],
      ['IpcMode', 'host'],
      ['UsernsMode', 'host'],
      ['SecurityOpt', ['seccomp=unconfined']],
      ['VolumesFrom', ['imp-host']],
      ['RestartPolicy', { Name: 'always', MaximumRetryCount: 0 }],
      ['MemorySwappiness', 60],
      ['Tmpfs', { '/x': '' }],
      ['Runtime', 'runc'],
      ['CgroupParent', '/'],
      ['PortBindings', { '22/tcp': [{ HostPort: '22' }] }],
    ];

    for (const [key, value] of cases) {
      expect(checkCreate({}, { [key]: value })).toBe(`HostConfig.${key} is set`);
    }
  });

  test('fails with an image on the host loopback or the host repository', () => {
    expect(checkCreate({ Image: '127.0.0.1:5000/x' })).toContain('IP address');
    expect(checkCreate({ Image: 'localhost:5000/x' })).toContain("the host's own");

    expect(checkCreate({ Image: 'ghcr.io/zgeoff/imp-host:latest' })).toContain(
      'imp-host runs from',
    );
  });

  test('fails when it is not an object, or has no Image', () => {
    expect(checkCreateBody([], HOST_IMAGE).isOk).toBe(false);
    expect(checkCreate({ Image: 1 })).toBe('Image is missing');
  });
});
