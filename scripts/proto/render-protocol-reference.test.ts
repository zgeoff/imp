import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRegistry, fromBinary } from '@bufbuild/protobuf';
import { FileDescriptorSetSchema } from '@bufbuild/protobuf/wkt';
import { invariant } from '@impz/test-utils/invariant';
import { renderProtocolReference } from './render-protocol-reference';

function setupTest() {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-reference-'));

  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  return { dir };
}

// buf compiles the schema with its comments, as buf generate hands it to the
// plugin
test('it renders the header comment, then a table per message', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'buf.yaml'), 'version: v2\n');

  writeFileSync(
    join(ctx.dir, 'demo.proto'),
    `// The demo protocol.
syntax = "proto3";

package demo;

// A request.
message Ask {
  // the op
  string op = 1;
  // when | set
  optional double at = 2;
  repeated string argv = 3;
  repeated Reply replies = 4;
  Reply reply = 5;
  bytes seed = 6;
}

message Reply {}
`,
  );

  Bun.spawnSync(['node_modules/.bin/buf', 'build', ctx.dir, '-o', join(ctx.dir, 'out.binpb')]);

  const set = fromBinary(FileDescriptorSetSchema, readFileSync(join(ctx.dir, 'out.binpb')));
  const file = createFileRegistry(set).getFile('demo.proto');

  invariant(file);

  expect(renderProtocolReference(file, 'Demo reference')).toMatchInlineSnapshot(`
    "# Demo reference

    <!-- Generated from demo.proto by bun run gen:proto. Edit the schema, not this file. -->

    The demo protocol.

    In each table, a field marked always is in every message the agent writes, zero or not; impd leaves a zero out, which reads as zero. A field marked when set appears only when its sender sets it, and a list appears as [] or not at all.

    ## Ask

    A request.

    | Field | Type | Presence | Description |
    | --- | --- | --- | --- |
    | \`op\` | string | always | the op |
    | \`at\` | double | when set | when \\| set |
    | \`argv\` | list of string | list |  |
    | \`replies\` | list of [Reply](#reply) | list |  |
    | \`reply\` | [Reply](#reply) | when set |  |
    | \`seed\` | bytes (base64) | always |  |

    ## Reply

    No fields.

    "
  `);
});

test('it renders the same schema the same way twice', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dir, 'buf.yaml'), 'version: v2\n');

  writeFileSync(
    join(ctx.dir, 'demo.proto'),
    `syntax = "proto3";

package demo;

// A reply.
message Reply {
  // the code
  int32 code = 1;
}
`,
  );

  Bun.spawnSync(['node_modules/.bin/buf', 'build', ctx.dir, '-o', join(ctx.dir, 'out.binpb')]);

  const set = fromBinary(FileDescriptorSetSchema, readFileSync(join(ctx.dir, 'out.binpb')));
  const file = createFileRegistry(set).getFile('demo.proto');

  invariant(file);

  expect(renderProtocolReference(file, 'Demo reference')).toBe(
    renderProtocolReference(file, 'Demo reference'),
  );
});
