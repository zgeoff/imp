import { describe, expect, test } from 'bun:test';
import { DOCKERFILE_FRONTEND } from './dockerfile-frontend';
import { parseQuery } from './router';
import {
  checkBuildContentType,
  checkBuildQuery,
  checkCreateBody,
  checkImageReference,
  checkPullQuery,
  checkReferenceRegistry,
  checkRemoveQuery,
  readImageReference,
} from './rules';

const HOST_IMAGE = 'ghcr.io/zgeoff/imp-host:latest';

// the query impd sends for a build: one tag, the frontend pinned
const BUILD_ARGS = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));
const BUILD = `t=imp%2Fx%3Alatest&version=2&buildargs=${BUILD_ARGS}`;

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
  return `t=imp%2Fx%3Alatest&version=2&buildargs=${encodeURIComponent(JSON.stringify(value))}`;
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
  test('passes as impd sends it, with or without a dockerfile', () => {
    expect(checkBuild(BUILD)).toBe('ok');
    expect(checkBuild(`${BUILD}&dockerfile=sub%2FDockerfile.dev`)).toBe('ok');
  });

  test('fails with a tag that is not imp/<name>:latest, or a second tag', () => {
    expect(checkBuild(`t=imp-host%3Alatest&version=2&buildargs=${BUILD_ARGS}`)).toContain(
      'param t',
    );

    expect(checkBuild(`t=imp%2Fx%3Av2&version=2&buildargs=${BUILD_ARGS}`)).toContain('param t');
    expect(checkBuild(`version=2&buildargs=${BUILD_ARGS}`)).toBe('param t is missing');
    expect(checkBuild(`${BUILD}&t=imp%2Fy%3Alatest`)).toBe('param t is given 2 times');
  });

  test('fails without version=2: the classic builder takes no frontend pin', () => {
    expect(checkBuild(`t=imp%2Fx%3Alatest&buildargs=${BUILD_ARGS}`)).toBe(
      'param version is missing',
    );

    expect(checkBuild(`t=imp%2Fx%3Alatest&version=1&buildargs=${BUILD_ARGS}`)).toBe(
      'param version is "1"',
    );

    expect(checkBuild(`${BUILD}&version=2`)).toBe('param version is given 2 times');
  });

  test('fails with a dockerfile outside the context', () => {
    for (const path of [
      '..%2FDockerfile',
      'a%2F..%2F..%2Fb',
      '%2Fetc%2Fpasswd',
      '.%2FDockerfile',
      'a%2F%2Fb',
    ]) {
      expect(checkBuild(`${BUILD}&dockerfile=${path}`)).toContain('not a path inside the context');
    }
  });

  test('fails without the pinned frontend: missing, by tag only, or another one', () => {
    expect(checkBuild('t=imp%2Fx%3Alatest&version=2')).toBe('param buildargs is missing');
    expect(checkBuild(buildArgsQuery({}))).toBe('param buildargs does not set BUILDKIT_SYNTAX');

    for (const frontend of [
      'docker/dockerfile:1',
      'docker/dockerfile:1.19',
      'docker/dockerfile@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6',
      'evil/frontend:1',
    ]) {
      expect(checkBuild(buildArgsQuery({ BUILDKIT_SYNTAX: frontend }))).toContain(
        'sets BUILDKIT_SYNTAX',
      );
    }

    expect(checkBuild(`t=imp%2Fx%3Alatest&version=2&buildargs=nope`)).toBe(
      'param buildargs is not JSON',
    );

    expect(checkBuild(`t=imp%2Fx%3Alatest&version=2&buildargs=%5B%5D`)).toBe(
      'param buildargs is not an object',
    );
  });

  test('fails with a build arg beside the pin', () => {
    for (const extra of ['HTTP_PROXY', 'BUILDKIT_CONTEXT_KEEP_GIT_DIR', 'BUILDKIT_INLINE_CACHE']) {
      expect(
        checkBuild(buildArgsQuery({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND, [extra]: '1' })),
      ).toBe(`param buildargs sets ${extra}="1"`);
    }
  });

  test('fails with each param that needs a session or moves the build', () => {
    for (const [key, value] of [
      ['session', 'abc'],
      ['remote', 'https://x'],
      ['networkmode', 'host'],
      ['buildid', 'x'],
      ['outputs', '[{"Type":"local"}]'],
      ['platform', 'linux/arm64'],
      ['pull', '1'],
      ['cachefrom', '["x"]'],
      ['target', 'x'],
      ['nocache', '1'],
      ['labels', '{}'],
      ['extrahosts', 'a:1.2.3.4'],
      ['shmsize', '1'],
      ['memory', '1'],
      ['q', '1'],
    ] as const) {
      expect(checkBuild(`${BUILD}&${key}=${encodeURIComponent(value)}`)).toBe(
        `param ${key} is not allowed`,
      );
    }
  });

  test('fails with a refused param given twice', () => {
    expect(checkBuild(`${BUILD}&networkmode=host&networkmode=host`)).toBe(
      'param networkmode is not allowed',
    );
  });
});

describe('a build Content-Type', () => {
  test('passes as `docker build` sends it, or when absent', () => {
    expect(checkBuildContentType('application/x-tar').isOk).toBe(true);
    expect(checkBuildContentType(null).isOk).toBe(true);
  });

  test('fails with a form, which the engine would read with the query', () => {
    for (const value of [
      'application/x-www-form-urlencoded',
      'application/x-www-form-urlencoded; charset=utf-8',
      'APPLICATION/X-WWW-FORM-URLENCODED',
      'multipart/form-data; boundary=x',
      'multipart/form-data',
    ]) {
      const checked = checkBuildContentType(value);
      const reason = checked.isOk ? 'ok' : checked.reason;

      expect(reason).toContain('is not application/x-tar');
    }
  });

  test('fails with any other value, a parameterised tar or an empty one included', () => {
    for (const value of [
      'application/x-tar; charset=utf-8',
      'application/x-tar ',
      '',
      'text/plain',
    ]) {
      expect(checkBuildContentType(value).isOk).toBe(false);
    }
  });
});

describe('an image reference', () => {
  test('names a refused registry in any case', () => {
    expect(checkReferenceRegistry('LocalHost/name')).toBe("registry LocalHost is the host's own");

    expect(checkReferenceRegistry('LOCALHOST:5000/x')).toBe(
      "registry LOCALHOST:5000 is the host's own",
    );

    expect(checkReferenceRegistry('Reg.LocalHost/x')).toBe(
      "registry Reg.LocalHost is the host's own",
    );

    expect(checkReferenceRegistry('ghcr.io/x')).toBeNull();
  });

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

    // docker lowercases the first label, so this is the localhost registry
    expect(readImageReference('LocalHost/name')).toEqual({
      registry: 'LocalHost',
      path: 'name',
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

    // the NixOS module's digest pin: the guard still names the repository
    expect(
      checkImageReference(
        'ghcr.io/zgeoff/imp-host:latest',
        'ghcr.io/zgeoff/imp-host:0.25.1@sha256:aa',
      ).isOk,
    ).toBe(false);

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
    expect(checkPull('fromImage=busybox')).toBe('param tag is missing');
  });
});

describe('a remove query', () => {
  test('takes force only', () => {
    expect(checkRemoveQuery(parseQuery('force=1')).isOk).toBe(true);
    expect(checkRemoveQuery(parseQuery('force=1&link=1')).isOk).toBe(false);
    expect(checkRemoveQuery(parseQuery('force=1&v=1')).isOk).toBe(false);
    expect(checkRemoveQuery(parseQuery('link=1')).isOk).toBe(false);
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
      ['Sysctls', { 'kernel.core_pattern': '|/x' }],
      ['DeviceRequests', [{ Driver: 'nvidia', Count: -1 }]],
      ['DeviceCgroupRules', ['b 7:* rmw']],
      ['PidMode', 'container:imp-host'],
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
