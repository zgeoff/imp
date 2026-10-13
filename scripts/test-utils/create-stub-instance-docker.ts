import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

export interface InstanceDockerStubOptions {
  // the containers that exist
  readonly containers: readonly string[];

  // more containers that exist once the `marker` file does, as a run that
  // starts them
  readonly startedLater?: Readonly<{ marker: string; containers: readonly string[] }>;
}

// The docker scripts/zfs-host-test.sh asks about its instances: `container
// inspect` succeeds only for a listed container, as Docker does, and the rest
// succeed silently. It logs each call to the shared stub log.
export function createStubInstanceDocker(
  stubs: string,
  options: Readonly<InstanceDockerStubOptions>,
): StubBin {
  const names = options.containers.map((name) => `'${name}'`).join(' ');
  const marker = options.startedLater?.marker ?? '';
  const later = (options.startedLater?.containers ?? []).map((name) => `'${name}'`).join(' ');

  return createStubBin(
    stubs,
    'docker',
    `if [ "$1" = container ] && [ "$2" = inspect ]; then
  for name in ${names}; do
    [ "$name" != "$3" ] || exit 0
  done
  if [ -n '${marker}' ] && [ -e '${marker}' ]; then
    for name in ${later}; do
      [ "$name" != "$3" ] || exit 0
    done
  fi
  echo "Error: No such container: $3" >&2
  exit 1
fi`,
  );
}
