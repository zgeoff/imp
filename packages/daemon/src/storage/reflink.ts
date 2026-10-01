import { runChecked } from '../process/run-command';

// An instant copy-on-write clone on XFS (DESIGN 2.4); fails instead of a
// full copy. Shared extents keep the holes, and cp refuses --sparse next to
// --reflink=always.
export async function createReflinkClone(source: string, target: string): Promise<void> {
  await runChecked(['cp', '--reflink=always', source, target]);
}
