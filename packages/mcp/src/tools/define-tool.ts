import type { ImpClient } from '@zgeoff/imp-client';
import { ExecError, ORPCError } from '@zgeoff/imp-client';
import * as z from 'zod';
import { GuardError } from '../imp-guard';
import type { ImpGuard } from '../imp-guard';

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface ToolContext {
  readonly client: ImpClient;
  readonly guard: ImpGuard;

  // the tool call's cancel: only imp_exec and the file tools pass it on, to
  // stop the command in the guest; impd finishes a create, fork or restore
  // it already started
  readonly signal: Readonly<AbortSignal>;
  readonly killGraceMs: number;
}

// MCP's tool annotations: hints for the client, which may ask the user
// before a destructive call
interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint: boolean;
}

interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
}

interface ToolResult {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
}

export interface Tool {
  readonly definition: ToolDefinition;

  // never throws for a failed call: the agent reads the failure as an
  // isError result; a cancel throws the signal's reason
  readonly call: (args: unknown, context: Readonly<ToolContext>) => Promise<ToolResult>;
}

// What a tool's run returns: `data` becomes both the structured content and
// its JSON text. `failed` reports a call that ran but did not do its job,
// such as a write whose command exited non-zero.
interface ToolOutput {
  readonly data: Readonly<Record<string, unknown>>;
  readonly failed?: string;
}

interface ToolSpec<Input extends z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly input: Input;
  readonly annotations: ToolAnnotations;
  readonly run: (input: z.output<Input>, context: Readonly<ToolContext>) => Promise<ToolOutput>;
}

// One zod schema per tool gives both the JSON Schema clients see and the
// check of the arguments a call brings.
export function defineTool<Input extends z.ZodObject>(spec: Readonly<ToolSpec<Input>>): Tool {
  const definition: ToolDefinition = {
    name: spec.name,
    title: spec.annotations.title,
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.input, { io: 'input' }),
    annotations: spec.annotations,
  };

  return {
    definition,
    call: async (args, context) => {
      const parsed = spec.input.safeParse(args ?? {});

      if (!parsed.success) {
        return buildErrorResult(`invalid arguments: ${z.prettifyError(parsed.error)}`);
      }

      try {
        const output = await spec.run(parsed.data, context);

        // the structured content is the text parsed back, so dates are the
        // same ISO strings in both
        const text = JSON.stringify(output.data, null, 2);
        const data = JsonObjectSchema.parse(JSON.parse(text));

        return {
          content: [
            {
              type: 'text',
              text: output.failed === undefined ? text : `${output.failed}\n${text}`,
            },
          ],
          structuredContent: data,
          isError: output.failed !== undefined,
        };
      } catch (error) {
        if (context.signal.aborted) {
          throw error;
        }

        return buildErrorResult(formatErrorText(error));
      }
    },
  };
}

function buildErrorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// impd's codes (NOT_FOUND, INVALID_STATE, RAM_BUDGET_EXCEEDED, …) lead, so
// the agent can tell what to do next
function formatErrorText(error: unknown): string {
  if (error instanceof ORPCError) {
    return `${String(error.code)}: ${error.message}`;
  }

  if (error instanceof ExecError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof GuardError) {
    return `GUARD: ${error.message}`;
  }

  return error instanceof Error ? error.message : String(error);
}
