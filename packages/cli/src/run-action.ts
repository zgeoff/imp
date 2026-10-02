import { ORPCError } from '@orpc/client';
import * as z from 'zod';
import { loadCliConfig } from './cli-config';
import type { CliConfig } from './cli-config';
import { createImpClient } from './create-imp-client';
import type { ImpClient } from './create-imp-client';
import { UsageError } from './usage-error';

export const TOKEN_HINT =
  'unauthorized: set IMP_TOKEN to the token from <IMP_DATA_DIR>/token, or run imp login <url>';

// what oRPC puts in a BAD_REQUEST's data when the input fails its schema
const PathKeySchema = z.union([z.string(), z.number(), z.object({ key: z.unknown() })]);
const IssueSchema = z.object({ message: z.string(), path: z.array(PathKeySchema).optional() });
const ValidationDataSchema = z.object({ issues: z.array(IssueSchema) });

// One line on stderr for any failure, instead of citty's stack dump, and
// exit code 2 for a usage error, else 1; a 401 gets a hint about where the
// token comes from.
export async function runAction(action: (client: ImpClient) => Promise<void>): Promise<void> {
  let config: CliConfig | null = null;

  try {
    config = loadCliConfig(process.env);

    await action(createImpClient(config));
  } catch (error) {
    printError(error, config);
  }
}

export function printError(error: unknown, config: CliConfig | null = null): void {
  console.error(`imp: ${formatError(error, config)}`);

  process.exitCode = error instanceof UsageError ? 2 : 1;
}

// `config` names the impd that was called, so a 401 can say which saved
// host to log in to again
export function formatError(error: unknown, config: CliConfig | null = null): string {
  if (error instanceof ORPCError) {
    if (error.status === 401) {
      return formatUnauthorized(config);
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

function formatUnauthorized(config: CliConfig | null): string {
  if (config?.host === null || config?.host === undefined) {
    return TOKEN_HINT;
  }

  return `unauthorized: ${config.host} (${config.url}) refused the token; run imp login ${config.url} --name ${config.host}`;
}
