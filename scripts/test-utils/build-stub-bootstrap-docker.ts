interface StubBootstrapDocker {
  // what `docker version` reads as the daemon's version; without it, the daemon does not answer
  readonly serverVersion?: string;

  // what `docker network inspect` prints for the imp-host network in deploy/bootstrap.sh's
  // NETWORK_FORMAT, and the containers on it; without it, there is no such network
  readonly hostNetwork?: string;
  readonly networkContainers?: readonly string[];

  // the images the host holds, and those of them that carry the unit's seccomp profile
  readonly images?: readonly string[];
  readonly seccompImages?: readonly string[];

  // what the imp-host container answers: `impz info` (with or without --json), `docker port`,
  // its findmnt of /var/lib/imp, its IPv6 default route, and its log
  readonly impInfo?: string;
  readonly published?: string;
  readonly dataMount?: string;
  readonly ipv6Route?: string;
  readonly logs?: string;
}

const SECCOMP_IN_IMAGE = '/usr/local/share/imp/deploy/imp-host.seccomp.json';

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function buildPrint(value: string | undefined): string {
  return value === undefined ? ':' : `printf '%s\\n' ${buildShellWord(value)}`;
}

// A stub docker's script, for createStubBin, that answers the calls deploy/bootstrap.sh makes
// of a host's Docker. Any call bootstrap.sh does not make fails as unexpected.
export function buildStubBootstrapDocker(stub: StubBootstrapDocker): string {
  // `docker load` takes an archive that holds no image the host lacks
  const version =
    stub.serverVersion === undefined
      ? 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1'
      : `echo ${buildShellWord(stub.serverVersion)}`;

  const noNetwork = 'echo "Error response from daemon: network imp-host not found" >&2; exit 1';
  const containers = (stub.networkContainers ?? []).map((name) => `${name} `).join('');
  const images = (stub.images ?? []).map((image) => buildShellWord(image));
  const seccompImages = (stub.seccompImages ?? []).map((image) => buildShellWord(image));

  return `case "$*" in
  "version -f {{.Server.Version}}") ${version} ;;
  "network inspect -f {{range .Containers}}{{.Name}} {{end}} imp-host") ${stub.hostNetwork === undefined ? noNetwork : `echo ${buildShellWord(containers)}`} ;;
  "network inspect -f "*" imp-host" | "network inspect imp-host") ${stub.hostNetwork === undefined ? noNetwork : `echo ${buildShellWord(stub.hostNetwork)}`} ;;
${images.map((image) => `  "image inspect "${image}) ;;`).join('\n')}
  "image inspect "*) echo "Error response from daemon: No such image: \${*: -1}" >&2; exit 1 ;;
  "load -q -i "*) ;;
${seccompImages.map((image) => `  "run --rm "${image}" cat ${SECCOMP_IN_IMAGE}") echo '{}' ;;`).join('\n')}
  "run --rm "*" cat ${SECCOMP_IN_IMAGE}") echo "cat: ${SECCOMP_IN_IMAGE}: No such file or directory" >&2; exit 1 ;;
  "exec imp-host impz info" | "exec imp-host impz info --json") ${buildPrint(stub.impInfo)} ;;
  "port imp-host") ${buildPrint(stub.published)} ;;
  "exec imp-host findmnt -n -r -o SOURCE,FSTYPE --mountpoint /var/lib/imp") ${buildPrint(stub.dataMount)} ;;
  "exec imp-host ip -6 route show default") ${buildPrint(stub.ipv6Route)} ;;
  "logs imp-host") ${buildPrint(stub.logs)} ;;
  *) echo "unexpected: docker $*" >&2; exit 1 ;;
esac`;
}
