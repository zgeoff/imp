interface StubDevHostDocker {
  // each container `docker inspect` knows, and whether it runs; any other is no such object
  readonly containers: Readonly<Record<string, boolean>>;

  // `docker image inspect` finds the host image
  readonly hasImage: boolean;

  // the proxy's socket is there, for `docker exec <proxy> test -S`
  readonly hasSocket: boolean;

  // each container's log, for `docker logs --tail`
  readonly logs?: Readonly<Record<string, string>>;

  // the impd pids `pgrep` finds in the container; none makes pgrep exit 1, as with no match
  readonly impdPids?: readonly number[];

  // `kill -0` of those pids fails once impd has exited after its SIGHUP; true by default
  readonly impdExits?: boolean;
}

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// A stub docker's script, for createStubBin, that answers scripts/dev/dev.sh up and restart: the host
// image, container states, the proxy's compile into the dir on /out, its socket, the logs, and
// restart's pgrep, SIGHUP and kill -0 of impd. Any other call fails, naming itself on stderr.
export function buildStubDevHostDocker(stub: StubDevHostDocker): string {
  const states = Object.entries(stub.containers).map(
    ([name, isRunning]) =>
      `  "inspect -f {{.State.Running}} "${buildShellWord(name)}) echo ${isRunning ? 'true' : 'false'} ;;`,
  );

  const logs = Object.entries(stub.logs ?? {}).map(
    ([name, log]) =>
      `  "logs --tail "*" "${buildShellWord(name)}) printf '%s' ${buildShellWord(log)} ;;`,
  );

  const pids = stub.impdPids ?? [];

  const pgrep =
    pids.length === 0
      ? '  "exec "*" pgrep -f "*) exit 1 ;;'
      : `  "exec "*" pgrep -f "*) printf '%s\\n' ${pids.join(' ')} ;;`;

  return [
    'case "$*" in',
    pgrep,
    '  "exec "*" kill -HUP "*) ;;',
    `  "exec "*" kill -0 "*) exit ${(stub.impdExits ?? true) ? 1 : 0} ;;`,
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
