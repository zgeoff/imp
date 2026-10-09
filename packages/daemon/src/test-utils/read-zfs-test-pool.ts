// The real pool a run may use, as root: the dataset in IMP_TEST_ZFS_ROOT and
// its mount dir in IMP_TEST_ZFS_DIR, which scripts/test-zfs.sh sets. Null
// unless both are set, so the `*.real.test.ts` suites skip everywhere else.
export function readZfsTestPool(): { parent: string; parentDir: string } | null {
  const parent = process.env['IMP_TEST_ZFS_ROOT'];
  const parentDir = process.env['IMP_TEST_ZFS_DIR'];

  if (parent === undefined || parentDir === undefined) {
    return null;
  }

  return { parent, parentDir };
}
