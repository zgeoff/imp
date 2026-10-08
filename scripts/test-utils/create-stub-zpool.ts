import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

export interface ZpoolStubOptions {
  // fails: the create fails; startedMarker: it writes that file, then takes
  // a second before the pool exists
  readonly create?: 'fails' | { readonly startedMarker: string };

  // fails: the destroy fails; ignored: it exits 0 and the pool stays
  readonly destroy?: 'fails' | 'ignored';
}

// A zpool that keeps its pools as `<name> <vdev>` lines in <dir>/pools, so
// list, status -P and destroy see what create made. It logs each call to the
// shared stub log, like createStubBin.
export function createStubZpool(stubs: string, options: Readonly<ZpoolStubOptions> = {}): StubBin {
  let onCreate = ':';

  if (options.create === 'fails') {
    onCreate = 'echo "pool already exists" >&2; exit 1';
  } else if (options.create !== undefined) {
    onCreate = `: >'${options.create.startedMarker}'; sleep 1`;
  }

  const onDestroy = { fails: 'exit 1', ignored: 'exit 0', none: ':' }[options.destroy ?? 'none'];

  return createStubBin(
    stubs,
    'zpool',
    String.raw`pools='${join(stubs, 'pools')}'
touch "$pools"
# the last two arguments: a create's pool and vdev, a destroy's pool
for arg; do prev=$last; last=$arg; done
case "$1" in
  list) grep -q "^$2 " "$pools" ;;
  create)
    ${onCreate}
    printf '%s %s\n' "$prev" "$last" >>"$pools" ;;
  status)
    want=$3
    while read -r pool file; do
      if [ -z "$want" ] || [ "$pool" = "$want" ]; then
        printf '  pool: %s\n\t  %s  ONLINE  0 0 0\n' "$pool" "$file"
      fi
    done <"$pools" ;;
  destroy)
    ${onDestroy}
    grep -v "^$last " "$pools" >"$pools.next" || true
    mv "$pools.next" "$pools" ;;
esac`,
  );
}
