// `bun run render:protocol`: packages/api/protocol-schema.json and the CLI's
// packages/cli/json-output-schema.json. `--check` writes nothing and fails on
// a difference, as scripts/render-protocol-schema.test.ts does under `bun test`.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildProtocolSchema } from '../packages/api/src/protocols/build-protocol-schema';
import { buildJsonOutputSchema } from '../packages/cli/src/output/build-json-output-schema';

export const PROTOCOL_SCHEMA_FILE = 'packages/api/protocol-schema.json';
export const JSON_OUTPUT_SCHEMA_FILE = 'packages/cli/json-output-schema.json';

export function renderProtocolSchema(): string {
  return `${JSON.stringify(buildProtocolSchema(), null, 2)}\n`;
}

export function renderJsonOutputSchema(): string {
  return `${JSON.stringify(buildJsonOutputSchema(), null, 2)}\n`;
}

function main(): void {
  const isCheck = process.argv.includes('--check');

  const files = [
    { path: PROTOCOL_SCHEMA_FILE, source: 'packages/api', next: renderProtocolSchema() },
    { path: JSON_OUTPUT_SCHEMA_FILE, source: 'packages/cli', next: renderJsonOutputSchema() },
  ];

  for (const file of files) {
    const current = readFileSync(file.path, { encoding: 'utf8', flag: 'a+' });

    if (isCheck) {
      if (file.next !== current) {
        console.error(
          `render-protocol-schema: ${file.path} differs from ${file.source}; run bun run render:protocol`,
        );

        process.exit(1);
      }

      console.log(`render-protocol-schema: ${file.path} matches ${file.source}`);
      continue;
    }

    writeFileSync(file.path, file.next);

    console.log(
      `render-protocol-schema: ${file.next === current ? `nothing new in ${file.path}` : `wrote ${file.path}`}`,
    );
  }
}

if (import.meta.main) {
  main();
}
