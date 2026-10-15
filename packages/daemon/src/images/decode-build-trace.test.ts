import { expect, test } from 'bun:test';
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import { decodeBuildTrace } from './decode-build-trace';

// two `moby.buildkit.trace` messages a Docker 29.8 engine sent for
// `RUN echo compiling widget && echo second line`: the step's start, then
// its output

test('it decodes the start of a step from an engine trace', () => {
  const aux =
    'CtQBCkdzaGEyNTY6MzhiZGNiOWVjNzI1YjA5MDFiNmU5ZWRlOWUxNmYxYzI2MDFiMmY4NTNjMWM3NzQ5MGQ0YTM2OWFlNjI5NDY4OBJHc2hhMjU2OjE5OGIxOTk0NWRhNGY3NWQ4Y2U1YTViZDhkYTIxZjJjMDFlYTljNzBhM2U2MGQzMmFkNWE5NzExMTFlMGE1MGUaM1syLzNdIFJVTiBlY2hvIGNvbXBpbGluZyB3aWRnZXQgJiYgZWNobyBzZWNvbmQgbGluZSoLCJDrwNYGEMawpnw=';

  expect(decodeBuildTrace(Buffer.from(aux, 'base64'))).toMatchInlineSnapshot(`
    {
      "logs": [],
      "vertexes": [
        {
          "cached": false,
          "completed": false,
          "digest": "sha256:38bdcb9ec725b0901b6e9ede9e16f1c2601b2f853c1c77490d4a369ae6294688",
          "error": "",
          "name": "[2/3] RUN echo compiling widget && echo second line",
          "started": true,
        },
      ],
    }
  `);
});

test('it decodes the output of a step from an engine trace', () => {
  const aux =
    'GngKR3NoYTI1NjozOGJkY2I5ZWM3MjViMDkwMWI2ZTllZGU5ZTE2ZjFjMjYwMWIyZjg1M2MxYzc3NDkwZDRhMzY5YWU2Mjk0Njg4EgwIkOvA1gYQ0uirpQIYASIdY29tcGlsaW5nIHdpZGdldApzZWNvbmQgbGluZQo=';

  const trace = decodeBuildTrace(Buffer.from(aux, 'base64'));

  expect(trace.vertexes).toStrictEqual([]);

  expect(
    trace.logs.map((log) => ({ vertex: log.vertex, text: new TextDecoder().decode(log.msg) })),
  ).toStrictEqual([
    {
      vertex: 'sha256:38bdcb9ec725b0901b6e9ede9e16f1c2601b2f853c1c77490d4a369ae6294688',
      text: 'compiling widget\nsecond line\n',
    },
  ]);
});

test('it decodes the same message to the same trace', () => {
  const bytes = Buffer.from(
    'CtQBCkdzaGEyNTY6MzhiZGNiOWVjNzI1YjA5MDFiNmU5ZWRlOWUxNmYxYzI2MDFiMmY4NTNjMWM3NzQ5MGQ0YTM2OWFlNjI5NDY4OBJHc2hhMjU2OjE5OGIxOTk0NWRhNGY3NWQ4Y2U1YTViZDhkYTIxZjJjMDFlYTljNzBhM2U2MGQzMmFkNWE5NzExMTFlMGE1MGUaM1syLzNdIFJVTiBlY2hvIGNvbXBpbGluZyB3aWRnZXQgJiYgZWNobyBzZWNvbmQgbGluZSoLCJDrwNYGEMawpnw=',
    'base64',
  );

  expect(decodeBuildTrace(bytes)).toStrictEqual(decodeBuildTrace(bytes));
});

test('it reads a cached vertex that ended with an error, past the fields it does not know', () => {
  const vertex = new BinaryWriter()
    .tag(1, WireType.LengthDelimited)
    .string('sha256:feed')
    .tag(3, WireType.LengthDelimited)
    .string('[3/4] RUN make test')
    .tag(4, WireType.Varint)
    .bool(true)
    .tag(6, WireType.LengthDelimited)
    .bytes(new Uint8Array([8, 1]))
    .tag(7, WireType.LengthDelimited)
    .string('exit code: 2')
    .tag(42, WireType.Varint)
    .uint32(7)
    .finish();

  const bytes = new BinaryWriter()
    .tag(2, WireType.LengthDelimited)
    .bytes(new Uint8Array([10, 1, 120]))
    .tag(1, WireType.LengthDelimited)
    .bytes(vertex)
    .finish();

  expect(decodeBuildTrace(bytes)).toStrictEqual({
    vertexes: [
      {
        digest: 'sha256:feed',
        name: '[3/4] RUN make test',
        cached: true,
        started: false,
        completed: true,
        error: 'exit code: 2',
      },
    ],
    logs: [],
  });
});
