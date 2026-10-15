interface StubHostDocker {
  // the image deploy/upgrade.sh pulls
  readonly image: string;

  // the imp.host-contract label of the image the imp-host container runs, and of the pulled one
  readonly runningLabel: string;
  readonly pulledLabel: string;

  // what each deploy/*.service in the pulled image holds
  readonly pulledUnit: string;

  // the pulled image is the one the container runs already
  readonly pulledIsRunning?: boolean;

  // the imps `impz ls` lists as running, and the one of them that `impz sleep` fails for
  readonly awakeImps?: readonly string[];
  readonly sleeplessImp?: string;

  // what `impz info --json` prints, `{}` unless set; null fails it
  readonly impInfo?: string | null;

  // the CLI the container has: impz, or imp in an image from before the CLI's rename
  readonly runningCLI?: 'imp' | 'impz';

  // the end of the deploy file whose `docker run ... cat` fails, such as .service
  readonly unreadableFile?: string;

  // what `docker compose config --environment` prints; without it, that fails as in a Compose
  // older than 2.24, after printing composeConfigError
  readonly composeConfig?: string;
  readonly composeConfigError?: string;
}

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// A stub docker's script, for createStubBin, that answers deploy/upgrade.sh as a host would:
// imp-host runs sha256:old, the pull is sha256:new, `compose config` logs the variables it
// saw, and any call upgrade.sh does not make fails as unexpected.
export function buildStubHostDocker(stub: StubHostDocker): string {
  const composeConfig =
    stub.composeConfig === undefined
      ? `printf '%s' ${buildShellWord(stub.composeConfigError ?? '')}; printf '%s' ${buildShellWord(stub.composeConfigError ?? '')} >&2; exit 1`
      : `printf '%s' ${buildShellWord(stub.composeConfig)}`;

  const imps = JSON.stringify((stub.awakeImps ?? []).map((name) => ({ name, state: 'running' })));

  const impInfo =
    stub.impInfo === null ? 'exit 1' : `printf '%s\\n' ${buildShellWord(stub.impInfo ?? '{}')}`;

  const cli = stub.runningCLI ?? 'impz';
  const version = cli === 'impz' ? 'echo 0.0.0' : 'exit 126';

  return `case "$*" in
  "inspect -f {{.Image}} imp-host") echo sha256:old ;;
  "inspect imp-host" | "pull -q "${buildShellWord(stub.image)}) ;;
  "image inspect -f {{.Id}} "${buildShellWord(stub.image)}) echo sha256:${stub.pulledIsRunning === true ? 'old' : 'new'} ;;
  "image inspect -f "*" sha256:old") echo ${buildShellWord(stub.runningLabel)} ;;
  "image inspect -f "*) echo ${buildShellWord(stub.pulledLabel)} ;;
  "run --rm "${buildShellWord(stub.image)}" cat "*${buildShellWord(stub.unreadableFile ?? 'none')}) exit 1 ;;
  "run --rm "${buildShellWord(stub.image)}" cat "*.service) printf '%s' ${buildShellWord(stub.pulledUnit)} ;;
  "run --rm "${buildShellWord(stub.image)}" cat "*.json) echo '{}' ;;
  "exec imp-host impz --version") ${version} ;;
  "exec imp-host ${cli} ls --json") echo ${buildShellWord(imps)} ;;
  "exec imp-host ${cli} sleep "${buildShellWord(stub.sleeplessImp ?? '')}) exit 1 ;;
  "exec imp-host ${cli} sleep "*) ;;
  "exec imp-host ${cli} info --json") ${impInfo} ;;
  "compose -f "*" config --environment")
    echo "compose config, IMP_HOST_IMAGE \${IMP_HOST_IMAGE-unset}, IMP_DOCKER_GID \${IMP_DOCKER_GID-unset}" >>"$STUB_CALLS"
    ${composeConfig} ;;
  "exec imp-host ${cli} ls" | "compose "*) ;;
  *) echo "unexpected: docker $*" >&2; exit 1 ;;
esac`;
}
