import { expect, test } from 'bun:test';
import { buildHostModeProxyArgv } from './host-mode-proxy';

test('it runs the proxy binary under host isolation with the privileges of the proxy section', () => {
  const argv = buildHostModeProxyArgv({
    argsJson: JSON.stringify({
      proxy: { privileges: [['--cap-drop', 'ALL'], ['--read-only']] },
      privileges: [['--cap-add', 'SYS_ADMIN']],
    }),
    name: 'imp-x-docker-proxy-host-mode-1',
    dockerGid: '998',
    hostImage: 'imp-host:dev-x',
    socketVolume: 'imp-x-docker',
    socket: '/run/imp-docker/host-mode-1.sock',
    binary: '/data/imp-docker-proxy',
  });

  expect(argv).toStrictEqual([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    'imp-x-docker-proxy-host-mode-1',
    '--cap-drop',
    'ALL',
    '--read-only',
    '--group-add',
    '998',
    '-e',
    'IMP_HOST_IMAGE=imp-host:dev-x',
    '-e',
    'IMP_BUILD_ISOLATION=host',
    '-e',
    'IMP_DOCKER_PROXY_LISTEN=/run/imp-docker/host-mode-1.sock',
    '-e',
    'IMP_DOCKER_PROXY_STATE=/tmp',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    'imp-x-docker:/run/imp-docker',
    '-v',
    '/data/imp-docker-proxy:/usr/local/bin/imp-docker-proxy:ro',
    'imp-host:dev-x',
    '/usr/local/bin/imp-docker-proxy',
  ]);
});

test('it rejects args without a proxy section', () => {
  expect(() =>
    buildHostModeProxyArgv({
      argsJson: JSON.stringify({ privileges: [] }),
      name: 'n',
      dockerGid: '1',
      hostImage: 'i',
      socketVolume: 'v',
      socket: '/s',
      binary: '/b',
    }),
  ).toThrow();
});
