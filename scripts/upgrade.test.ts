import { afterAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const UPGRADE = new URL('../deploy/upgrade.sh', import.meta.url).pathname;

const IMAGE = 'ghcr.io/zgeoff/imp-host:next';
const PRIVILEGED_UNIT = 'ExecStart=/usr/bin/docker run --init --privileged imp-host\n';
const UNPRIVILEGED_UNIT = 'ExecStart=/usr/bin/docker run --init --cap-drop ALL imp-host\n';

// a #75 unit: unprivileged, with the host's docker.sock
const SOCKET_UNIT =
  'ExecStart=/usr/bin/docker run --cap-drop ALL -v /var/run/docker.sock:/var/run/docker.sock imp-host\n';

// this release's: the proxy's socket
const PROXY_UNIT =
  'ExecStart=/usr/bin/docker run --cap-drop ALL -e DOCKER_HOST=unix:///run/imp-docker/docker.sock imp-host\n';

const root = mkdtempSync(join(process.env['TMPDIR'] ?? '/tmp', 'imp-upgrade-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Host {
  // the image's imp.host-contract label: the one upgraded to, the one running
  readonly newLabel: string;
  readonly oldLabel: string;
  readonly unit: string;
  readonly compose?: string;

  // the deploy file whose `docker run ... cat` fails, such as .service
  readonly failCat?: string;

  // mv fails, as on a read-only /etc
  readonly failMv?: boolean;
}

// Fakes docker, systemctl and curl: each call lands in calls, the running
// container is image sha256:old, the pulled one sha256:new, and the new
// image's unit is UNPRIVILEGED_UNIT.
async function runUpgrade(host: Host) {
  const dir = mkdtempSync(join(root, 'run-'));
  const calls = join(dir, 'calls');
  const unitFile = join(dir, 'imp-host.service');
  const proxyUnitFile = join(dir, 'imp-docker-proxy.service');
  const seccompFile = join(dir, 'imp-host.seccomp.json');
  const composeFile = join(dir, 'compose.yaml');

  const docker = `#!/bin/bash
echo "docker $*" >>'${calls}'
case "$*" in
  "inspect -f {{.Image}} imp-host") echo sha256:old ;;
  "inspect imp-host" | "pull -q ${IMAGE}") ;;
  "image inspect -f {{.Id}} ${IMAGE}") echo sha256:new ;;
  "image inspect -f "*" sha256:old") echo '${host.oldLabel}' ;;
  "image inspect -f "*) echo '${host.newLabel}' ;;
  "run --rm ${IMAGE} cat "*${host.failCat ?? 'none'}) exit 1 ;;
  "run --rm ${IMAGE} cat "*.service) printf '%s' '${UNPRIVILEGED_UNIT}' ;;
  "run --rm ${IMAGE} cat "*.json) echo '{}' ;;
  "exec imp-host imp ls --json") echo '[]' ;;
  "exec imp-host imp info --json") echo '{}' ;;
  "exec imp-host imp ls" | "compose "*) ;;
  *) echo "unexpected: docker $*" >&2; exit 1 ;;
esac
`;

  writeFileSync(join(dir, 'docker'), docker);
  writeFileSync(join(dir, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >>'${calls}'\n`);
  writeFileSync(join(dir, 'curl'), '#!/bin/sh\necho \'{"ready":true}\'\n');

  const fakes = ['docker', 'systemctl', 'curl'];

  if (host.failMv === true) {
    writeFileSync(join(dir, 'mv'), '#!/bin/sh\necho "mv: cannot move" >&2\nexit 1\n');

    fakes.push('mv');
  }

  for (const name of fakes) {
    chmodSync(join(dir, name), 0o755);
  }

  writeFileSync(calls, '');
  writeFileSync(unitFile, host.unit);

  if (host.compose !== undefined) {
    writeFileSync(composeFile, host.compose);
  }

  const proc = Bun.spawn(
    ['bash', UPGRADE, ...(host.compose === undefined ? [] : ['--compose', composeFile])],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env['PATH'] ?? ''}`,
        IMP_HOST_IMAGE: IMAGE,
        IMP_HOST_UNIT_FILE: unitFile,
        IMP_DOCKER_PROXY_UNIT_FILE: proxyUnitFile,
        IMP_HOST_SECCOMP_FILE: seccompFile,
      },
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    output: stdout + stderr,
    calls: readFileSync(calls, 'utf8'),
    unit: readFileSync(unitFile, 'utf8'),
    proxyUnit: existsSync(proxyUnitFile) ? readFileSync(proxyUnitFile, 'utf8') : null,
    seccomp: existsSync(seccompFile) ? readFileSync(seccompFile, 'utf8') : null,
    leftovers: [unitFile, proxyUnitFile, seccompFile].filter((file) => existsSync(`${file}.new`)),
  };
}

test('an upgrade to the unprivileged host installs its unit before the restart', async () => {
  const result = await runUpgrade({
    newLabel: 'unprivileged',
    oldLabel: '',
    unit: PRIVILEGED_UNIT,
  });

  expect(result.exitCode).toBe(0);
  expect(result.unit).toBe(UNPRIVILEGED_UNIT);
  expect(result.seccomp).toBe('{}\n');
  expect(result.calls).toContain('systemctl daemon-reload\nsystemctl restart imp-host\n');
  expect(result.output).toContain('predates this host contract (unprivileged): to roll back');
  expect(result.proxyUnit).toBeNull();
});

test('an upgrade from the #75 host installs both units, then restarts the proxy before imp-host', async () => {
  const result = await runUpgrade({
    newLabel: 'socket-proxy',
    oldLabel: 'unprivileged',
    unit: SOCKET_UNIT,
  });

  expect(result.exitCode).toBe(0);
  expect(result.unit).toBe(UNPRIVILEGED_UNIT);
  expect(result.proxyUnit).toBe(UNPRIVILEGED_UNIT);

  expect(result.calls).toContain(
    'systemctl daemon-reload\nsystemctl enable -q imp-docker-proxy\n' +
      'systemctl restart imp-docker-proxy\nsystemctl restart imp-host\n',
  );

  expect(result.output).toContain('run deploy/bootstrap.sh of its release');
});

test('an upgrade between proxy hosts tells how to roll back by restarting both units', async () => {
  const result = await runUpgrade({
    newLabel: 'socket-proxy',
    oldLabel: 'socket-proxy',
    unit: PROXY_UNIT,
  });

  expect(result.exitCode).toBe(0);
  expect(result.output).toContain('then systemctl restart imp-docker-proxy imp-host');
});

test('a rollback past the socket proxy is refused before anything changes', async () => {
  const result = await runUpgrade({
    newLabel: 'unprivileged',
    oldLabel: 'socket-proxy',
    unit: PROXY_UNIT,
  });

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('predates the Docker socket proxy');
  expect(result.unit).toBe(PROXY_UNIT);
  expect(result.calls).not.toContain('systemctl');
  expect(result.calls).not.toContain('imp sleep');
});

test('compose with the host socket in imp-host gets a NOTE, and starts imp-host alone', async () => {
  const result = await runUpgrade({
    newLabel: 'socket-proxy',
    oldLabel: 'unprivileged',
    unit: SOCKET_UNIT,
    compose:
      'services:\n  imp-host:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n',
  });

  expect(result.exitCode).toBe(0);
  expect(result.calls).toMatch(/docker compose -f \S+ up -d imp-host\n/v);
  expect(result.output).toContain("still gives imp-host the host's docker.sock");
});

test('compose with the proxy service starts it with imp-host', async () => {
  const result = await runUpgrade({
    newLabel: 'socket-proxy',
    oldLabel: 'socket-proxy',
    unit: PROXY_UNIT,
    compose:
      'services:\n  imp-docker-proxy:\n    image: x\n  imp-host:\n' +
      '    environment:\n      DOCKER_HOST: unix:///run/imp-docker/docker.sock\n',
  });

  expect(result.exitCode).toBe(0);
  expect(result.calls).toMatch(/docker compose -f \S+ up -d imp-docker-proxy imp-host\n/v);
  expect(result.output).not.toContain('NOTE: ');
});

test('a rollback past the unprivileged host is refused before anything changes', async () => {
  const result = await runUpgrade({
    newLabel: '',
    oldLabel: 'unprivileged',
    unit: UNPRIVILEGED_UNIT,
  });

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('run deploy/bootstrap.sh of that');
  expect(result.unit).toBe(UNPRIVILEGED_UNIT);
  expect(result.calls).not.toContain('systemctl');
  expect(result.calls).not.toContain('imp sleep');
});

test('compose keeps its file and is told it still runs privileged', async () => {
  const result = await runUpgrade({
    newLabel: 'unprivileged',
    oldLabel: '',
    unit: PRIVILEGED_UNIT,
    compose: 'services:\n  imp-host:\n    privileged: true\n',
  });

  expect(result.exitCode).toBe(0);
  expect(result.unit).toBe(PRIVILEGED_UNIT);
  expect(result.seccomp).toBe('{}\n');
  expect(result.calls).toContain(`docker compose -f`);
  expect(result.output).toContain('still runs privileged');
});

test('an image that cannot give its unit stops the upgrade before any imp sleeps', async () => {
  const result = await runUpgrade({
    newLabel: 'unprivileged',
    oldLabel: '',
    unit: PRIVILEGED_UNIT,
    failCat: '.service',
  });

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('cannot read');
  expect(result.unit).toBe(PRIVILEGED_UNIT);
  expect(result.seccomp).toBeNull();
  expect(result.leftovers).toEqual([]);
  expect(result.calls).not.toContain('imp ls');
  expect(result.calls).not.toContain('systemctl');
});

test('a unit that cannot be installed stops the upgrade before the restart', async () => {
  const result = await runUpgrade({
    newLabel: 'unprivileged',
    oldLabel: '',
    unit: PRIVILEGED_UNIT,
    failMv: true,
  });

  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('cannot install');
  expect(result.output).not.toContain('installed');
  expect(result.unit).toBe(PRIVILEGED_UNIT);
  expect(result.leftovers).toEqual([]);
  expect(result.calls).not.toContain('systemctl');
});
