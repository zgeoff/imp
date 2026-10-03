import { open } from 'node:fs/promises';
import { writeLocalEntries } from '@imp/local-tar';
import type { LocalEntry } from '@imp/local-tar';
import { printLog } from '../process/print-log';

const NO_PROGRESS = { add: () => {} };

// the entries as a tar file at path, which must not exist yet
export async function writeContextTar(entries: readonly LocalEntry[], path: string): Promise<void> {
  const file = await open(path, 'wx', 0o600);

  try {
    await writeLocalEntries(
      entries,
      async (chunk) => {
        await file.write(chunk);
      },
      NO_PROGRESS,
      (text) => {
        printLog(`impd: image build context: ${text}`);
      },
    );
  } finally {
    await file.close();
  }
}
