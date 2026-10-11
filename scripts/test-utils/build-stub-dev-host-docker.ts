interface StubDevHostDocker {
  // each container `docker inspect` knows, and whether it runs; any other is no such object
  readonly containers: Readonly<Record<string, boolean>>;

  // `docker image inspect` finds the host image
  readonly hasImage: boolean;

  // the proxy's socket is there, for `docker exec <proxy> test -S`
  readonly hasSocket: boolean;

  // each container's log, for `docker logs --tail`
  readonly logs?: Readonly<Record<string, string>>;
}

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// A stub docker's script, for createStubBin, that answers scripts/dev.sh up and restart: the host
// image, container states, the proxy's compile into the dir on /out, its socket, and the logs.
// Any other call fails, naming itself on stderr.
export function buildStubDevHostDocker(stub: StubDevHostDocker): string {
  const states = Object.entries(stub.containers).map(
    ([name, isRunning]) =>
      `  "inspect -f {{.State.Running}} "${buildShellWord(name)}) echo ${isRunning ? 'true' : 'false'} ;;`,
  );

  const logs = Object.entries(stub.logs ?? {}).map(
    ([name, log]) =>
      `  "logs --tail "*" "${buildShellWord(name)}) printf '%s' ${buildShellWord(log)} ;;`,
  );

  return [
    'case "$*" in',
    '  "image inspect -f {{.Id}} "*) echo sha256:stub-host-image ;;',
    `  "image inspect "*) exit ${stub.hasImage ? 0 : 1} ;;`,
    ...states,
    '  "inspect -f {{.State.Running}} "*) echo "Error: No such object" >&2; exit 1 ;;',
    '  "run --rm "*)',
    '    for arg in "$@"; do',
    `      case $arg in *:/out) : >"$(printf '%s' "$arg" | sed 's|:/out$||')/imp-docker-proxy.new" ;; esac`,
    '    done',
    '    ;;',
    '  "run -d "*) echo c0ffee ;;',
    '  "rm -f "*) ;;',
    `  "exec "*" test -S /run/imp-docker/docker.sock") exit ${stub.hasSocket ? 0 : 1} ;;`,
    ...logs,
    '  "logs --tail "*) ;;',
    '  *) echo "stub docker: unexpected call: $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n');
}
