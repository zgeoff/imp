import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateReadOnly } from './update-read-only';

// Whether updateReadOnly works on a tree under tmpdir(): root needs chattr +i,
// which a container without CAP_LINUX_IMMUTABLE or an older tmpfs refuses.
export function canUpdateReadOnly(): boolean {
  const stack = new DisposableStack();

  const dir = mkdtempSync(join(tmpdir(), 'can-update-read-only-'));

  stack.defer(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  try {
    updateReadOnly(stack, dir);

    return true;
  } catch {
    return false;
  } finally {
    stack.dispose();
  }
}
