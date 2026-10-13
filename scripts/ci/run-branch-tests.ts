// imp's test:related for the pre-push baseline. The root bun test skips the
// dashboard (bunfig.toml pathIgnorePatterns), so a dashboard file's tests run
// from its package, as test:dashboard runs them.
import { join } from 'node:path';
import { runRelatedTests } from './run-related-tests.ts';

const dashboardPrefix = 'packages/dashboard/';

export async function runBranchTests(paths: readonly string[], cwd: string): Promise<number> {
  const dashboard = paths
    .filter((path) => path.startsWith(dashboardPrefix))
    .map((path) => path.slice(dashboardPrefix.length));

  const root = paths.filter((path) => !path.startsWith(dashboardPrefix));

  const rootExitCode = await runRelatedTests(root, cwd);
  const dashboardExitCode = await runRelatedTests(dashboard, join(cwd, dashboardPrefix));

  return rootExitCode === 0 ? dashboardExitCode : rootExitCode;
}

if (import.meta.main) {
  const exitCode = await runBranchTests(process.argv.slice(2), process.cwd());

  process.exit(exitCode);
}
