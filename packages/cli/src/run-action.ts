import { ORPCError } from '@orpc/client';
import * as z from 'zod';
import { createImpClient } from './create-imp-client';
import type { ImpClient } from './create-imp-client';

export const TOKEN_HINT =
  'unauthorized: set IMP_TOKEN or write the token from <IMP_DATA_DIR>/token to ~/.config/imp/token';

// what oRPC puts in a BAD_REQUEST's data when the input fails its schema
const PathKeySchema = z.union([z.string(), z.number(), z.object({ key: z.unknown() })]);
const IssueSchema = z.object({ message: z.string(), path: z.array(PathKeySchema).optional() });
const ValidationDataSchema = z.object({ issues: z.array(IssueSchema) });

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

export function formatError(error: unknown): string {
  if (error instanceof ORPCError) {
    if (error.status === 401) {
      return TOKEN_HINT;
    }

    const code = String(error.code);
    const data: unknown = error.data;

    return `${code}: ${error.message}${formatIssues(code, data)}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

// a validation failure's issues, as ` (…)`, or nothing; other codes put
// their details (RAM_BUDGET_EXCEEDED's numbers) in the message
function formatIssues(code: string, data: unknown): string {
  const validation = code === 'BAD_REQUEST' ? ValidationDataSchema.safeParse(data) : null;

  if (validation?.success !== true) {
    return '';
  }

  const issues = validation.data.issues.map((issue) => {
    const path = (issue.path ?? [])
      .map((key) => (typeof key === 'object' ? String(key.key) : String(key)))
      .join('.');

    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });

  return ` (${issues.join('; ')})`;
}
