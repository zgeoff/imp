// the variables a run's own command sets to pick which tests run: the host
// networking tests, the build disk hold, and the real-pool ZFS tests
const RUN_GATES = new Set([
  'IMP_HOST_TESTS',
  'IMP_TEST_SMALL_FS',
  'IMP_TEST_ZFS_ROOT',
  'IMP_TEST_ZFS_DIR',
]);

// Removes every IMP_* variable the run started with, except the run gates, so
// impd settings from a developer's shell never reach a test: a test that needs
// one sets it with updateEnv.
export function removeAmbientImpEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('IMP_') && !RUN_GATES.has(key)) {
      delete process.env[key];
    }
  }
}
