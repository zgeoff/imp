import { createStubBin } from './create-stub-bin';
import type { StubBin } from './create-stub-bin';

export interface ZfsStubOptions {
  // fails: zfs create fails, as when the pool cannot take the dataset
  readonly create?: 'fails';
}

// The zfs userland the ZFS scripts call: version prints OpenZFS 2.3.4's two
// lines, create succeeds unless told to fail, and the rest succeed silently.
// It logs each call to the shared stub log.
export function createStubZfs(stubs: string, options: Readonly<ZfsStubOptions> = {}): StubBin {
  const onCreate = options.create === 'fails' ? 'echo "cannot create dataset" >&2; exit 1' : ':';

  return createStubBin(
    stubs,
    'zfs',
    `case "$1" in
  version) printf 'zfs-2.3.4-1\\nzfs-kmod-2.3.4-1\\n' ;;
  create) ${onCreate} ;;
esac`,
  );
}
