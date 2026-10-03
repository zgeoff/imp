// imp-docker-proxy: the Docker socket imp-host sees, served from a container
// of its own. It closes the Docker socket path only; SYS_ADMIN still lets
// root out of imp-host (docs/architecture/host-contract.md).

import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { printLog } from '../process/print-log';
import { loadOrCreateToken } from '../token';
import { loadOwnedImages } from './owned-images';
import { createDockerProxy } from './proxy';

// headers and a create body on top of the largest build context
const BODY_SLACK_BYTES = 1024 ** 2;

function readEnv(name: string, fallback: string): string {
  const value = process.env[name];

  return value === undefined || value === '' ? fallback : value;
}

// No default: a fallback tag could name another repository than the image the
// proxy runs from, and the rule that keeps a pull off that repository would
// guard the wrong one. Every unit and compose file sets it.
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; set it to the image this proxy runs from`);
  }

  return value;
}

function main(): void {
  const listen = readEnv('IMP_DOCKER_PROXY_LISTEN', '/run/imp-docker/docker.sock');
  const upstreamSocket = readEnv('IMP_DOCKER_PROXY_UPSTREAM', '/var/run/docker.sock');
  const stateDir = readEnv('IMP_DOCKER_PROXY_STATE', '/var/lib/imp-docker-proxy');
  const hostImage = requireEnv('IMP_HOST_IMAGE');
  const contextMib = Number(readEnv('IMP_BUILD_CONTEXT_MAX_MIB', '1024'));

  if (!Number.isInteger(contextMib) || contextMib <= 0) {
    throw new Error(
      `IMP_BUILD_CONTEXT_MAX_MIB is ${String(process.env['IMP_BUILD_CONTEXT_MAX_MIB'])}, not a count`,
    );
  }

  const buildContextMaxBytes = contextMib * 1024 ** 2;

  const handleRequest = createDockerProxy({
    upstreamSocket,
    token: loadOrCreateToken(stateDir),
    hostImage,
    buildContextMaxBytes,
    ownedImages: loadOwnedImages(join(stateDir, 'owned-images.json')),
    log: printLog,
  });

  // a socket left by the last run would fail the listen
  rmSync(listen, { force: true });

  // Bun's types leave idleTimeout off unix servers, but it applies there
  // too: 0 lets a build or an export stream for as long as it takes
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  const serveOptions = {
    unix: listen,
    fetch: handleRequest,
    maxRequestBodySize: buildContextMaxBytes + BODY_SLACK_BYTES,
    idleTimeout: 0,
  } as unknown as Bun.Serve.Options<undefined>;

  const server = Bun.serve(serveOptions);

  chmodSync(listen, 0o600);
  printLog(`imp-docker-proxy on ${listen}, engine ${upstreamSocket}, host image ${hostImage}`);

  const stop = async (): Promise<void> => {
    await server.stop(true);

    rmSync(listen, { force: true });

    process.exit(0);
  };

  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main();
