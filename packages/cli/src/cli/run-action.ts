import { MissingFeatureError, ORPCError } from '@impz/client';
import * as z from 'zod';
import { loadCliConfig } from '../config/cli-config';
import type { CliConfig } from '../config/cli-config';
import { createImpClient } from '../config/create-imp-client';
import type { ImpClient } from '../config/create-imp-client';
import type { ImpzExtension } from './impz-plugin';

const TOKEN_HINT =
  'unauthorized: set IMP_TOKEN to the token from <IMP_DATA_DIR>/token, or run impz login <url>';

// what oRPC puts in a BAD_REQUEST's data when the input fails its schema
const PathKeySchema = z.union([z.string(), z.number(), z.object({ key: z.unknown() })]);
const IssueSchema = z.object({ message: z.string(), path: z.array(PathKeySchema).optional() });
const ValidationDataSchema = z.object({ issues: z.array(IssueSchema) });

// Calls impd with the config and client the command's host and IO pick. A
// failure goes on to main, which prints it; a 401 names the saved host to log
// in to again, which only this call knows.
export async function runAction(
  impz: ImpzExtension,
  action: (client: ImpClient) => Promise<void>,
): Promise<void> {
  const config = loadCliConfig(impz.io.env, impz.host, impz.io.printError);

  try {
    await action(createImpClient(config));
  } catch (error) {
    throw toCallError(error, config);
  }
}

// a failure of a call to the impd `config` names, as main prints it: a 401
// says which saved host to log in to again
export function toCallError(error: unknown, config: CliConfig): unknown {
  if (error instanceof ORPCError && error.status === 401) {
    return new Error(formatUnauthorized(config), { cause: error });
  }

  return error;
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

  // the client's refusal names what an older impd would do; the CLI says
  // how to get past it
  if (error instanceof MissingFeatureError) {
    return `${error.message}. Upgrade impd, or use an older imp CLI`;
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

// a 401: which token to fix, and where it came from
export function formatUnauthorized(config: CliConfig | null): string {
  if (config?.host === null || config?.host === undefined) {
    return TOKEN_HINT;
  }

  return `unauthorized: ${config.host} (${config.url}) refused the token; run impz login ${config.url} --name ${config.host}`;
}
