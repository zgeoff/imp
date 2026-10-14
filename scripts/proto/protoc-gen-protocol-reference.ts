// A protoc plugin, which buf.gen.yaml runs: the Markdown reference for the
// agent protocol, from proto/imp/agent/v1/agent.proto.
import { create, createFileRegistry, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  CodeGeneratorRequestSchema,
  CodeGeneratorResponseSchema,
  CodeGeneratorResponse_Feature,
  FileDescriptorSetSchema,
} from '@bufbuild/protobuf/wkt';
import { renderProtocolReference } from './render-protocol-reference';

const SCHEMA_FILE = 'imp/agent/v1/agent.proto';

async function main(): Promise<void> {
  const input = await Bun.stdin.bytes();

  const request = fromBinary(CodeGeneratorRequestSchema, input);
  const registry = createFileRegistry(create(FileDescriptorSetSchema, { file: request.protoFile }));
  const file = registry.getFile(SCHEMA_FILE);

  if (file === undefined) {
    throw new Error(`protoc-gen-protocol-reference: no ${SCHEMA_FILE} in the request`);
  }

  const response = create(CodeGeneratorResponseSchema, {
    supportedFeatures: BigInt(CodeGeneratorResponse_Feature.PROTO3_OPTIONAL),
    file: [
      {
        name: 'agent-protocol.md',
        content: renderProtocolReference(file, 'Agent protocol reference'),
      },
    ],
  });

  await Bun.write(Bun.stdout, toBinary(CodeGeneratorResponseSchema, response));
}

await main();
