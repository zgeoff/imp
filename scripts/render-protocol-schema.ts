// `bun run render:protocol`: the protocol into packages/api/protocol-schema.json.
// `--check` writes nothing and fails on a difference, as
// scripts/render-protocol-schema.test.ts does under `bun test`.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildProtocolSchema } from '../packages/api/src/protocols/build-protocol-schema';

export const PROTOCOL_SCHEMA_FILE = 'packages/api/protocol-schema.json';

export function renderProtocolSchema(): string {
  return `${JSON.stringify(buildProtocolSchema(), null, 2)}\n`;
}

function main(): void {
  const next = renderProtocolSchema();
  const current = readFileSync(PROTOCOL_SCHEMA_FILE, { encoding: 'utf8', flag: 'a+' });

  if (process.argv.includes('--check')) {
    if (next !== current) {
      console.error(
        `render-protocol-schema: ${PROTOCOL_SCHEMA_FILE} differs from packages/api; run bun run render:protocol`,
      );

      process.exit(1);
    }

    console.log(`render-protocol-schema: ${PROTOCOL_SCHEMA_FILE} matches packages/api`);

    return;
  }

  writeFileSync(PROTOCOL_SCHEMA_FILE, next);

  console.log(
    `render-protocol-schema: ${next === current ? 'nothing new' : `wrote ${PROTOCOL_SCHEMA_FILE}`}`,
  );
}

if (import.meta.main) {
  main();
}
