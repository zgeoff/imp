import { ORPCError } from '@orpc/client';
import { createImpClient } from './create-imp-client';
import type { ImpClient } from './create-imp-client';

// One line on stderr and exit code 1 for any failure, instead of citty's
// stack dump; a 401 gets a hint about where the token comes from.
export async function runAction(action: (client: ImpClient) => Promise<void>): Promise<void> {
  try {
    await action(createImpClient());
  } catch (error) {
    console.error(`imp: ${formatError(error)}`);

    process.exitCode = 1;
  }
}

function formatError(error: unknown): string {
  if (error instanceof ORPCError) {
    if (error.status === 401) {
      return 'unauthorized: set IMP_TOKEN or write the token from <IMP_DATA_DIR>/token to ~/.config/imp/token';
    }

    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
