import * as z from 'zod';

const WordsSchema = z.array(z.string());
const ProxyArgsSchema = z.object({ proxy: z.object({ privileges: z.array(WordsSchema) }) });

export interface HostModeProxyOptions {
  // deploy/imp-host.args.json, whose proxy privileges the container takes
  readonly argsJson: string;
  readonly name: string;

  // the group that owns the host's /var/run/docker.sock
  readonly dockerGid: string;
  readonly hostImage: string;

  // the volume the dev proxy's socket lives in, and the path this proxy
  // listens on inside it
  readonly socketVolume: string;
  readonly socket: string;

  // the imp-docker-proxy binary in the instance's data dir
  readonly binary: string;
}

// `docker run` for a second imp-docker-proxy of the dev proxy's binary and
// privileges under IMP_BUILD_ISOLATION=host, on a socket beside the dev
// proxy's; --rm, so the container goes once it stops.
export function buildHostModeProxyArgv(options: Readonly<HostModeProxyOptions>): string[] {
  const args = ProxyArgsSchema.parse(JSON.parse(options.argsJson));
  const privileges = args.proxy.privileges.flat();

  return [
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    options.name,
    ...privileges,
    '--group-add',
    options.dockerGid,
    '-e',
    `IMP_HOST_IMAGE=${options.hostImage}`,
    '-e',
    'IMP_BUILD_ISOLATION=host',
    '-e',
    `IMP_DOCKER_PROXY_LISTEN=${options.socket}`,
    '-e',
    'IMP_DOCKER_PROXY_STATE=/tmp',
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '-v',
    `${options.socketVolume}:/run/imp-docker`,
    '-v',
    `${options.binary}:/usr/local/bin/imp-docker-proxy:ro`,
    options.hostImage,
    '/usr/local/bin/imp-docker-proxy',
  ];
}
