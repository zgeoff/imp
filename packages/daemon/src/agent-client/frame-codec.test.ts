import { expect, test } from 'bun:test';
import { invariant } from '@imp/test-utils/invariant';
import {
  FRAME_TYPES,
  MAX_PAYLOAD,
  createFrameDecoder,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from './frame-codec';

// the same vectors as agent/internal/proto/proto_test.go

test('it writes the type and the big-endian payload length before the payload', () => {
  const bytes = encodeJsonFrame(FRAME_TYPES.request, { op: 'ping' });

  expect([...bytes]).toStrictEqual([1, 0, 0, 0, 13, ...new TextEncoder().encode('{"op":"ping"}')]);
});

test('it round-trips request, empty and raw frames', () => {
  const bytes = Uint8Array.from([
    ...encodeJsonFrame(FRAME_TYPES.request, { op: 'ping' }),
    ...encodeFrame(FRAME_TYPES.stdinEof),
    ...encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('hello')),
  ]);

  const decoder = createFrameDecoder();
  const frames = decoder.push(bytes);

  expect(frames).toStrictEqual([
    { type: FRAME_TYPES.request, payload: new TextEncoder().encode('{"op":"ping"}') },
    { type: FRAME_TYPES.stdinEof, payload: new Uint8Array() },
    { type: FRAME_TYPES.stdout, payload: new TextEncoder().encode('hello') },
  ]);

  expect(() => {
    decoder.end();
  }).not.toThrow();
});

test('it decodes frames split across chunks at any byte', () => {
  const bytes = Uint8Array.from([
    ...encodeJsonFrame(FRAME_TYPES.exit, { code: 7, signal: 0 }),
    ...encodeFrame(FRAME_TYPES.stderr, new TextEncoder().encode('oops')),
  ]);

  const decoder = createFrameDecoder();
  const frames = [...bytes].flatMap((byte) => decoder.push(Uint8Array.of(byte)));

  expect(frames).toStrictEqual([
    { type: FRAME_TYPES.exit, payload: new TextEncoder().encode('{"code":7,"signal":0}') },
    { type: FRAME_TYPES.stderr, payload: new TextEncoder().encode('oops') },
  ]);
});

test('it decodes a JSON payload', () => {
  const [frame] = createFrameDecoder().push(
    encodeJsonFrame(FRAME_TYPES.exit, { code: 7, signal: 0 }),
  );

  invariant(frame);

  expect(decodeJsonPayload(frame)).toStrictEqual({ code: 7, signal: 0 });
});

test('it splits a payload larger than the maximum into several frames', () => {
  const data = new Uint8Array(MAX_PAYLOAD + 10).fill(120);

  const frames = createFrameDecoder().push(encodeFrame(FRAME_TYPES.stdout, data));

  expect(frames).toStrictEqual([
    { type: FRAME_TYPES.stdout, payload: new Uint8Array(MAX_PAYLOAD).fill(120) },
    { type: FRAME_TYPES.stdout, payload: new Uint8Array(10).fill(120) },
  ]);
});

test('it rejects a frame longer than the maximum', () => {
  const header = Uint8Array.of(8, 0, 0, 0, 0);

  new DataView(header.buffer).setUint32(1, MAX_PAYLOAD + 1);

  expect(() => createFrameDecoder().push(header)).toThrowWithMessage(
    Error,
    'agent frame too large: 1048577 bytes',
  );
});

test.each([
  ['inside a header', Uint8Array.of(8, 0, 0), 3],
  ['inside a payload', Uint8Array.of(8, 0, 0, 0, 4, 97), 6],
])('it reports a stream that ends %s', (_label, input, pending) => {
  const decoder = createFrameDecoder();

  decoder.push(input);

  expect(() => {
    decoder.end();
  }).toThrowWithMessage(Error, `agent stream ended inside a frame (${String(pending)} bytes)`);
});

test.each([
  ['inside a header', Uint8Array.of(8, 0, 0)],
  ['inside a payload', Uint8Array.of(8, 0, 0, 0, 4, 97)],
])('it decodes no frame yet from bytes that stop %s', (_label, input) => {
  expect(createFrameDecoder().push(input)).toStrictEqual([]);
});
