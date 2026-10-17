import { buildProtocolSchema } from '@impz/api';
import * as z from 'zod';

const CommandOutputSchema = z
  .object({
    // the procedure whose answer the command prints as it came
    procedure: z.string(),
    schema: z.record(z.string(), z.unknown()).readonly(),
  })
  .readonly();

// the shape of packages/cli/json-output-schema.json, which the check reads back
export const JsonOutputSchemaSchema = z
  .object({ outputs: z.record(z.string(), CommandOutputSchema).readonly() })
  .readonly();

export type JsonOutputSchema = z.infer<typeof JsonOutputSchemaSchema>;

// The `--json` outputs that other programs read, keyed by the command after
// `impz`: cloud's `db copy` and `info`, and hq's capacity reads.
const COVERED_OUTPUTS = {
  info: 'system.info',
  'info <name>': 'imps.get',
  ls: 'imps.list',
  'db copy': 'system.copyDatabase',
} as const;

// What packages/cli/json-output-schema.json holds, for the breaking-change
// check: docs/guides/cli.md#json-output.
export function buildJsonOutputSchema(): JsonOutputSchema {
  const procedures = buildProtocolSchema().procedures;

  return {
    outputs: Object.fromEntries(
      Object.entries(COVERED_OUTPUTS).map(([command, procedure]) => {
        const answer = procedures[procedure];

        if (answer === undefined || answer.stream) {
          throw new Error(`impz ${command} --json prints ${procedure}, which is not one answer`);
        }

        return [command, { procedure, schema: answer.output }];
      }),
    ),
  };
}
