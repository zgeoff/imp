import { buildUnshare } from './build-unshare';

// Whether a host test can run the command in a fresh network namespace.
// IMP_HOST_TESTS=required answers yes without asking, so a missing tool or
// namespace fails the test instead of skipping it, as in CI's root step.
export function canUnshare(command: readonly string[]): boolean {
  if (process.env['IMP_HOST_TESTS'] === 'required') {
    return true;
  }

  const unshare = buildUnshare({ mount: false, uid: process.getuid?.() });
  const probe = Bun.spawnSync([...unshare, ...command], { stdout: 'ignore', stderr: 'ignore' });

  return probe.exitCode === 0;
}
