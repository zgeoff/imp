import { expect, test } from 'bun:test';
import {
  FRAME_TYPES,
  MAX_PAYLOAD,
  createFrameDecoder,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from './frame-codec';

// the same vectors as agent/internal/proto/proto_test.go

test('it round-trips request, empty and raw frames', () => {
  const bytes = Uint8Array.from([
    ...encodeJsonFrame(FRAME_TYPES.request, { op: 'ping' }),
    ...encodeFrame(FRAME_TYPES.stdinEof),
    ...encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('hello')),
  ]);

  expect([...bytes.subarray(0, 5)]).toEqual([1, 0, 0, 0, 13]);

  const decoder = createFrameDecoder();
  const frames = decoder.push(bytes);

  expect(frames.map((frame) => [frame.type, new TextDecoder().decode(frame.payload)])).toEqual([
    [FRAME_TYPES.request, '{"op":"ping"}'],
    [FRAME_TYPES.stdinEof, ''],
    [FRAME_TYPES.stdout, 'hello'],
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

  expect(frames).toHaveLength(2);

  expect(decodeJsonPayload(frames[0] ?? { type: 0, payload: new Uint8Array() })).toEqual({
    code: 7,
    signal: 0,
  });
});

test('it splits a payload larger than the maximum into several frames', () => {
  const data = new Uint8Array(MAX_PAYLOAD + 10).fill(120);

  const frames = createFrameDecoder().push(encodeFrame(FRAME_TYPES.stdout, data));

  expect(frames.map((frame) => frame.payload.byteLength)).toEqual([MAX_PAYLOAD, 10]);
});

test('it rejects a frame longer than the maximum', () => {
  const header = Uint8Array.of(8, 0, 0, 0, 0);

  new DataView(header.buffer).setUint32(1, MAX_PAYLOAD + 1);

  expect(() => createFrameDecoder().push(header)).toThrow('too large');
});

test('it reports a stream that ends inside a frame', () => {
  for (const input of [Uint8Array.of(8, 0, 0), Uint8Array.of(8, 0, 0, 0, 4, 97)]) {
    const decoder = createFrameDecoder();

    expect(decoder.push(input)).toEqual([]);

    expect(() => {
      decoder.end();
    }).toThrow('ended inside a frame');
  }
});
