import { expect, test } from 'bun:test';
import { DOCKERFILE_FRONTEND } from './dockerfile-frontend';
import { parseQuery } from './router';
import {
  checkBuildContentType,
  checkBuildQuery,
  checkCreateBody,
  checkImageReference,
  checkNoQuery,
  checkPullQuery,
  checkReferenceRegistry,
  checkRemoveQuery,
  readImageReference,
} from './rules';

// the query impd sends for a build: one tag, the frontend pinned
test('#checkBuildQuery passes a build query as impd sends it', () => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(
    checkBuildQuery(parseQuery(`t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}`)),
  ).toStrictEqual({ isOk: true });
});

test('#checkBuildQuery passes a build query that names a dockerfile inside the context', () => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(
    checkBuildQuery(
      parseQuery(
        `t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}&dockerfile=sub%2FDockerfile.dev`,
      ),
    ),
  ).toStrictEqual({ isOk: true });
});

test.each([
  ['imp-host%3Alatest', 'param t "imp-host:latest" is not imp/<name>:latest'],
  ['imp%2Fx%3Av2', 'param t "imp/x:v2" is not imp/<name>:latest'],
  ['imp%2Fx%3Alatest&t=imp%2Fy%3Alatest', 'param t is given 2 times'],
])('#checkBuildQuery refuses a build query whose t is %s', (tag, reason) => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(checkBuildQuery(parseQuery(`t=${tag}&version=2&buildargs=${buildargs}`))).toStrictEqual({
    isOk: false,
    reason,
  });
});

test('#checkBuildQuery refuses a build query without a tag', () => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(checkBuildQuery(parseQuery(`version=2&buildargs=${buildargs}`))).toStrictEqual({
    isOk: false,
    reason: 'param t is missing',
  });
});

// the classic builder, version 1, takes no frontend pin
test('#checkBuildQuery refuses a build query without version 2', () => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(checkBuildQuery(parseQuery(`t=imp%2Fx%3Alatest&buildargs=${buildargs}`))).toStrictEqual({
    isOk: false,
    reason: 'param version is missing',
  });
});

test('#checkBuildQuery refuses a build query that gives version twice', () => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(
    checkBuildQuery(parseQuery(`t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}&version=2`)),
  ).toStrictEqual({ isOk: false, reason: 'param version is given 2 times' });
});

test('#checkBuildQuery refuses a build query for the classic builder', () => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(
    checkBuildQuery(parseQuery(`t=imp%2Fx%3Alatest&version=1&buildargs=${buildargs}`)),
  ).toStrictEqual({ isOk: false, reason: 'param version is "1"' });
});

test.each([
  ['..%2FDockerfile', '../Dockerfile'],
  ['a%2F..%2F..%2Fb', 'a/../../b'],
  ['%2Fetc%2Fpasswd', '/etc/passwd'],
  ['.%2FDockerfile', './Dockerfile'],
  ['a%2F%2Fb', 'a//b'],
  ['', ''],
  ['a%20b', 'a b'],
])('#checkBuildQuery refuses a dockerfile %s outside the context', (encoded, path) => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(
    checkBuildQuery(
      parseQuery(`t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}&dockerfile=${encoded}`),
    ),
  ).toStrictEqual({
    isOk: false,
    reason: `param dockerfile is ${JSON.stringify(path)}, not a path inside the context`,
  });
});

test('#checkBuildQuery refuses a build query without build args', () => {
  expect(checkBuildQuery(parseQuery('t=imp%2Fx%3Alatest&version=2'))).toStrictEqual({
    isOk: false,
    reason: 'param buildargs is missing',
  });
});

test('#checkBuildQuery refuses build args that do not pin the frontend', () => {
  const buildargs = encodeURIComponent(JSON.stringify({}));

  expect(
    checkBuildQuery(parseQuery(`t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}`)),
  ).toStrictEqual({ isOk: false, reason: 'param buildargs does not set BUILDKIT_SYNTAX' });
});

test.each([
  ['docker/dockerfile:1'],
  ['docker/dockerfile:1.19'],
  ['docker/dockerfile@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6'],
  ['evil/frontend:1'],
])('#checkBuildQuery refuses build args that pin the frontend %s', (frontend) => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: frontend }));

  expect(
    checkBuildQuery(parseQuery(`t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}`)),
  ).toStrictEqual({
    isOk: false,
    reason: `param buildargs sets BUILDKIT_SYNTAX=${JSON.stringify(frontend)}`,
  });
});

test('#checkBuildQuery refuses build args that are not JSON', () => {
  expect(checkBuildQuery(parseQuery('t=imp%2Fx%3Alatest&version=2&buildargs=nope'))).toStrictEqual({
    isOk: false,
    reason: 'param buildargs is not JSON',
  });
});

test('#checkBuildQuery refuses build args that are not an object', () => {
  expect(
    checkBuildQuery(parseQuery('t=imp%2Fx%3Alatest&version=2&buildargs=%5B%5D')),
  ).toStrictEqual({ isOk: false, reason: 'param buildargs is not an object' });
});

test.each([['HTTP_PROXY'], ['BUILDKIT_CONTEXT_KEEP_GIT_DIR'], ['BUILDKIT_INLINE_CACHE']])(
  '#checkBuildQuery refuses build args that set %s beside the pin',
  (extra) => {
    const buildargs = encodeURIComponent(
      JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND, [extra]: '1' }),
    );

    expect(
      checkBuildQuery(parseQuery(`t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}`)),
    ).toStrictEqual({ isOk: false, reason: `param buildargs sets ${extra}="1"` });
  },
);

// each needs a session, or moves the build off its context, network or tag
test.each([
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
])('#checkBuildQuery refuses a build query with %s=%s', (key, value) => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));
  const param = encodeURIComponent(value);

  expect(
    checkBuildQuery(
      parseQuery(`t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}&${key}=${param}`),
    ),
  ).toStrictEqual({ isOk: false, reason: `param ${key} is not allowed` });
});

test('#checkBuildQuery refuses a refused param given twice as not allowed', () => {
  const buildargs = encodeURIComponent(JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND }));

  expect(
    checkBuildQuery(
      parseQuery(
        `t=imp%2Fx%3Alatest&version=2&buildargs=${buildargs}&networkmode=host&networkmode=host`,
      ),
    ),
  ).toStrictEqual({ isOk: false, reason: 'param networkmode is not allowed' });
});

test('#checkBuildContentType passes the tar Content-Type docker build sends', () => {
  expect(checkBuildContentType('application/x-tar')).toStrictEqual({ isOk: true });
});

test('#checkBuildContentType passes a build with no Content-Type', () => {
  expect(checkBuildContentType(null)).toStrictEqual({ isOk: true });
});

// a form body the engine would read with the query, a parameterised or
// padded tar, and any other value
test.each([
  ['application/x-www-form-urlencoded'],
  ['application/x-www-form-urlencoded; charset=utf-8'],
  ['APPLICATION/X-WWW-FORM-URLENCODED'],
  ['multipart/form-data; boundary=x'],
  ['multipart/form-data'],
  ['application/x-tar; charset=utf-8'],
  ['application/x-tar '],
  [''],
  ['text/plain'],
])('#checkBuildContentType refuses the Content-Type %p', (value) => {
  expect(checkBuildContentType(value)).toStrictEqual({
    isOk: false,
    reason: `a build body is a tar context, and Content-Type ${JSON.stringify(value)} is not application/x-tar`,
  });
});

// docker lowercases the registry, so any case of localhost is the host's
test.each([
  ['LocalHost/name', "registry LocalHost is the host's own"],
  ['LOCALHOST:5000/x', "registry LOCALHOST:5000 is the host's own"],
  ['Reg.LocalHost/x', "registry Reg.LocalHost is the host's own"],
  ['10.0.0.5:5000/y', 'registry 10.0.0.5:5000 is an IP address'],
])('#checkReferenceRegistry names the refused registry of %s', (reference, problem) => {
  expect(checkReferenceRegistry(reference)).toBe(problem);
});

test('#checkReferenceRegistry passes a named registry', () => {
  expect(checkReferenceRegistry('ghcr.io/x')).toBeNull();
});

test.each([
  ['busybox', 'docker.io', 'library/busybox'],
  ['docker.io/library/busybox:1.36', 'docker.io', 'library/busybox'],
  ['index.docker.io/library/busybox', 'docker.io', 'library/busybox'],
  ['ghcr.io/zgeoff/imp-host:latest', 'ghcr.io', 'zgeoff/imp-host'],
  ['localhost:5000/x@sha256:ab', 'localhost:5000', 'x'],
  ['LocalHost/name', 'LocalHost', 'name'],
  ['imp-host:dev', 'docker.io', 'library/imp-host'],
  ['zgeoff/imp:1', 'docker.io', 'zgeoff/imp'],
])('#readImageReference reads %s as registry %s and path %s', (reference, registry, path) => {
  expect(readImageReference(reference)).toStrictEqual({ registry, path });
});

test.each([
  ['localhost/x', "registry localhost is the host's own"],
  ['localhost:5000/x', "registry localhost:5000 is the host's own"],
  ['reg.localhost/x', "registry reg.localhost is the host's own"],
  ['127.0.0.1:5000/x', 'registry 127.0.0.1:5000 is an IP address'],
  ['169.254.169.254/x', 'registry 169.254.169.254 is an IP address'],
  ['[::1]:5000/x', 'image "[::1]:5000/x" is not a reference'],
  ['[fe80::1]/x', 'image "[fe80::1]/x" is not a reference'],
  [
    'ghcr.io/zgeoff/imp-host:other',
    'image ghcr.io/zgeoff/imp-host:other is the repository imp-host runs from',
  ],
  [
    'ghcr.io/zgeoff/imp-host@sha256:aa',
    'image ghcr.io/zgeoff/imp-host@sha256:aa is the repository imp-host runs from',
  ],
  ['-busybox', 'image "-busybox" is not a reference'],
  ['busy box', 'image "busy box" is not a reference'],
])('#checkImageReference refuses the image %s', (reference, reason) => {
  expect(checkImageReference(reference, 'ghcr.io/zgeoff/imp-host:latest')).toStrictEqual({
    isOk: false,
    reason,
  });
});

test('#checkImageReference refuses the repository of a host image on Docker Hub', () => {
  expect(checkImageReference('imp-host:dev', 'imp-host:dev')).toStrictEqual({
    isOk: false,
    reason: 'image imp-host:dev is the repository imp-host runs from',
  });
});

// the NixOS module pins the host image by digest: the guard still names its
// repository
test('#checkImageReference refuses the repository of a host image pinned by digest', () => {
  expect(
    checkImageReference(
      'ghcr.io/zgeoff/imp-host:latest',
      'ghcr.io/zgeoff/imp-host:0.25.1@sha256:aa',
    ),
  ).toStrictEqual({
    isOk: false,
    reason: 'image ghcr.io/zgeoff/imp-host:latest is the repository imp-host runs from',
  });
});

test('#checkImageReference passes another repository of the host image registry', () => {
  expect(
    checkImageReference('ghcr.io/zgeoff/other:latest', 'ghcr.io/zgeoff/imp-host:latest'),
  ).toStrictEqual({ isOk: true });
});

test('#checkPullQuery passes a pull as docker pull sends it', () => {
  expect(
    checkPullQuery(
      parseQuery('fromImage=docker.io%2Flibrary%2Fbusybox&tag=latest'),
      'ghcr.io/zgeoff/imp-host:latest',
      null,
    ),
  ).toStrictEqual({ isOk: true });
});

// `docker pull <DOCKERFILE_FRONTEND>` sends the digest as the tag; the
// rule a base image's pull meets, with no exception for it
test('#checkPullQuery passes a pull of the Dockerfile frontend by its digest', () => {
  const digest = encodeURIComponent(DOCKERFILE_FRONTEND.split('@')[1] ?? '');

  expect(
    checkPullQuery(
      parseQuery(`fromImage=docker.io%2Fdocker%2Fdockerfile&tag=${digest}`),
      'ghcr.io/zgeoff/imp-host:latest',
      null,
    ),
  ).toStrictEqual({ isOk: true });
});

test.each([
  ['fromSrc=-&repo=x', 'param fromSrc is not allowed'],
  ['fromImage=busybox&tag=latest&changes=CMD', 'param changes is not allowed'],
  ['fromImage=busybox&tag=a&tag=b', 'param tag is given 2 times'],
  ['fromImage=busybox&tag=a%20b', 'param tag is "a b"'],
  ['tag=latest', 'param fromImage is missing'],
  ['fromImage=busybox', 'param tag is missing'],
  ['fromImage=127.0.0.1%3A5000%2Fx&tag=latest', 'registry 127.0.0.1:5000 is an IP address'],
  [
    'fromImage=ghcr.io%2Fzgeoff%2Fimp-host&tag=evil',
    'image ghcr.io/zgeoff/imp-host is the repository imp-host runs from',
  ],
])('#checkPullQuery refuses the pull query %s', (raw, reason) => {
  expect(checkPullQuery(parseQuery(raw), 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: false,
    reason,
  });
});

// `docker pull <repo>:<tag>@<digest>` sends the repository and the digest
test('#checkPullQuery passes a pull of IMP_BUILD_IMAGE by its digest under imp isolation', () => {
  const digest = `sha256:${'d'.repeat(64)}`;

  expect(
    checkPullQuery(
      parseQuery(`fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=${digest}`),
      'ghcr.io/zgeoff/imp-host:latest',
      `ghcr.io/zgeoff/imp-base:0.29.0@${digest}`,
    ),
  ).toStrictEqual({ isOk: true });
});

// the engine pulls fromImage's repository at the tag, whatever else it names
test.each([
  ['docker.io/library/busybox', '1.37'],
  ['ghcr.io/zgeoff/imp-base', '0.29.0'],
  ['ghcr.io/zgeoff/imp-base', `sha256:${'e'.repeat(64)}`],
  ['ghcr.io/zgeoff/imp-other', `sha256:${'d'.repeat(64)}`],
  ['docker.io/zgeoff/imp-base', `sha256:${'d'.repeat(64)}`],
  [`ghcr.io/zgeoff/imp-base@sha256:${'e'.repeat(64)}`, `sha256:${'e'.repeat(64)}`],
])('#checkPullQuery refuses a pull of %s at %s under imp isolation', (fromImage, tag) => {
  const only = `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`;

  const query = new URLSearchParams({ fromImage, tag }).toString();

  expect(checkPullQuery(parseQuery(query), 'ghcr.io/zgeoff/imp-host:latest', only)).toStrictEqual({
    isOk: false,
    reason: `a pull of ${fromImage}:${tag} is refused: under IMP_BUILD_ISOLATION=imp the proxy pulls only IMP_BUILD_IMAGE, ${only}`,
  });
});

test.each([
  ['fromImage=ghcr.io%2Fzgeoff%2Fimp-base', 'param tag is missing'],
  [
    `fromImage=ghcr.io%2Fzgeoff%2Fimp-base&tag=sha256%3A${'d'.repeat(64)}&repo=x`,
    'param repo is not allowed',
  ],
])('#checkPullQuery keeps the rules every pull meets under imp isolation for %s', (raw, reason) => {
  const only = `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`;

  expect(checkPullQuery(parseQuery(raw), 'ghcr.io/zgeoff/imp-host:latest', only)).toStrictEqual({
    isOk: false,
    reason,
  });
});

test('#checkRemoveQuery passes the force docker rm -f sends', () => {
  expect(checkRemoveQuery(parseQuery('force=1'))).toStrictEqual({ isOk: true });
});

test.each([
  ['force=1&link=1', 'param link is not allowed'],
  ['force=1&v=1', 'param v is not allowed'],
  ['link=1', 'param link is not allowed'],
  ['force=yes', 'param force is "yes"'],
])('#checkRemoveQuery refuses the remove query %s', (raw, reason) => {
  expect(checkRemoveQuery(parseQuery(raw))).toStrictEqual({ isOk: false, reason });
});

test('#checkNoQuery passes a call with no params', () => {
  expect(checkNoQuery(parseQuery(''))).toStrictEqual({ isOk: true });
});

test('#checkNoQuery refuses a call with a param', () => {
  expect(checkNoQuery(parseQuery('name=x'))).toStrictEqual({
    isOk: false,
    reason: 'param name is not allowed',
  });
});

// the body `docker create busybox /bin/true` 29.8 sends
test('#checkCreateBody passes a create body as docker create sends it', () => {
  const body = {
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

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: true,
    image: 'busybox',
  });
});

test('#checkCreateBody refuses a create body with another command', () => {
  const body = {
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
    Cmd: ['/bin/sh'],
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

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: false,
    reason: 'Cmd is ["/bin/sh"], not ["/bin/true"]',
  });
});

test.each([
  ['Entrypoint', ['/bin/sh']],
  ['Labels', { a: 'b' }],
  ['Volumes', { '/x': {} }],
  ['Env', ['A=1']],
  ['User', 'root'],
  ['AttachStdin', true],
  ['Healthcheck', { Test: ['CMD', 'x'] }],
])('#checkCreateBody refuses a create body that sets %s', (key, value) => {
  const body = {
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
    [key]: value,
  };

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: false,
    reason: `${key} is set`,
  });
});

test.each([
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
])('#checkCreateBody refuses a create body whose HostConfig sets %s to %p', (key, value) => {
  const body = {
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
      [key]: value,
    },
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: false,
    reason: `HostConfig.${key} is set`,
  });
});

test('#checkCreateBody refuses a create body whose HostConfig is not an object', () => {
  const body = {
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
    HostConfig: 'host',
    NetworkingConfig: {
      EndpointsConfig: { default: { IPAMConfig: null, Links: null, Aliases: null } },
    },
  };

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: false,
    reason: 'HostConfig is not an object',
  });
});

test.each([
  ['127.0.0.1:5000/x', 'registry 127.0.0.1:5000 is an IP address'],
  ['localhost:5000/x', "registry localhost:5000 is the host's own"],
  [
    'ghcr.io/zgeoff/imp-host:latest',
    'image ghcr.io/zgeoff/imp-host:latest is the repository imp-host runs from',
  ],
])('#checkCreateBody refuses a create body from the image %s', (image, reason) => {
  const body = {
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
    Image: image,
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

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: false,
    reason,
  });
});

test('#checkCreateBody refuses a create body that is not an object', () => {
  expect(checkCreateBody([], 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: false,
    reason: 'the body is not a JSON object',
  });
});

test('#checkCreateBody refuses a create body with no Image', () => {
  const body = {
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
    Image: 1,
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

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', null)).toStrictEqual({
    isOk: false,
    reason: 'Image is missing',
  });
});

test.each([
  [`ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`],
  [`ghcr.io/zgeoff/imp-base@sha256:${'d'.repeat(64)}`],
])('#checkCreateBody passes a create from IMP_BUILD_IMAGE as %s under imp isolation', (image) => {
  const only = `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`;

  const body = {
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
    Image: image,
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

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', only)).toStrictEqual({
    isOk: true,
    image,
  });
});

test.each([
  ['busybox'],
  ['ghcr.io/zgeoff/imp-base:0.29.0'],
  [`ghcr.io/zgeoff/imp-base@sha256:${'e'.repeat(64)}`],
  [`ghcr.io/zgeoff/imp-other@sha256:${'d'.repeat(64)}`],
  [`sha256:${'d'.repeat(64)}`],
])('#checkCreateBody refuses a create from %s under imp isolation', (image) => {
  const only = `ghcr.io/zgeoff/imp-base:0.29.0@sha256:${'d'.repeat(64)}`;

  const body = {
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
    Image: image,
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

  expect(checkCreateBody(body, 'ghcr.io/zgeoff/imp-host:latest', only)).toStrictEqual({
    isOk: false,
    reason: `a create from ${image} is refused: under IMP_BUILD_ISOLATION=imp the proxy creates only from IMP_BUILD_IMAGE, ${only}`,
  });
});
