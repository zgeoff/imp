// Pulls the Pebble suite's pinned images before `bun run test:pebble` runs
// its tests, so no test pays for a pull inside its own time budget.
import { PEBBLE_IMAGES } from '../test/e2e/lib/pebble';

for (const image of PEBBLE_IMAGES) {
  const pull = Bun.spawnSync(['docker', 'pull', '--quiet', image], {
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (pull.exitCode !== 0) {
    throw new Error(`docker pull ${image} exited ${String(pull.exitCode)}`);
  }
}
