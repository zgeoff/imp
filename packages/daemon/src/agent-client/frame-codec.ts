// The agent wire format (docs/architecture/protocol.md#frames):
// `[u8 type][u32 BE length][payload]`.

export const FRAME_TYPES = {
  request: 1,
  response: 2,
  stdin: 3,
  stdinEof: 4,
  resize: 5,
  signal: 6,
  started: 7,
  stdout: 8,
  stderr: 9,
  exit: 10,
  detached: 11,

  // dial: the target closed its side
  stdoutEof: 12,

  // agent.listen: a client of the socket waits for an agent.accept
  connection: 13,

  // services.logs: how far the stream has sent
  cursor: 14,
} as const;

export type FrameType = (typeof FRAME_TYPES)[keyof typeof FRAME_TYPES];

export const MAX_PAYLOAD = 1 << 20;
const HEADER_SIZE = 5;

export interface AgentFrame {
  readonly type: number;
  readonly payload: Uint8Array;
}

export interface FrameDecoder {
  // the frames the bytes so far complete; a partial frame waits for more
  readonly push: (chunk: Uint8Array) => AgentFrame[];

  // throws when the stream ended inside a frame
  readonly end: () => void;
}

// One frame, or several when the payload is larger than MAX_PAYLOAD; an empty
// payload is still one frame.
export function encodeFrame(type: FrameType, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const count = Math.max(1, Math.ceil(payload.byteLength / MAX_PAYLOAD));

  const out = new Uint8Array(payload.byteLength + count * HEADER_SIZE);
  const view = new DataView(out.buffer);

  let offset = 0;

  for (let index = 0; index < count; index += 1) {
    const chunk = payload.subarray(index * MAX_PAYLOAD, (index + 1) * MAX_PAYLOAD);

    out[offset] = type;

    view.setUint32(offset + 1, chunk.byteLength);
    out.set(chunk, offset + HEADER_SIZE);

    offset += HEADER_SIZE + chunk.byteLength;
  }

  return out;
}

export function encodeJsonFrame(type: FrameType, value: unknown): Uint8Array {
  return encodeFrame(type, new TextEncoder().encode(JSON.stringify(value)));
}

export function createFrameDecoder(): FrameDecoder {
  let pending: Uint8Array = new Uint8Array();

  const decodeChunk = (chunk: Uint8Array): AgentFrame[] => {
    pending = mergeBytes(pending, chunk);

    const frames: AgentFrame[] = [];
    let offset = 0;

    while (pending.byteLength - offset >= HEADER_SIZE) {
      const view = new DataView(pending.buffer, pending.byteOffset + offset, HEADER_SIZE);

      const length = view.getUint32(1);

      if (length > MAX_PAYLOAD) {
        throw new Error(`agent frame too large: ${String(length)} bytes`);
      }

      if (pending.byteLength - offset < HEADER_SIZE + length) {
        break;
      }

      const start = offset + HEADER_SIZE;

      frames.push({ type: view.getUint8(0), payload: pending.slice(start, start + length) });

      offset = start + length;
    }

    pending = pending.slice(offset);

    return frames;
  };

  const checkEnded = (): void => {
    if (pending.byteLength > 0) {
      throw new Error(`agent stream ended inside a frame (${String(pending.byteLength)} bytes)`);
    }
  };

  return { push: decodeChunk, end: checkEnded };
}

export function decodeJsonPayload(frame: AgentFrame): unknown {
  return JSON.parse(new TextDecoder().decode(frame.payload));
}

function mergeBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) {
    return b;
  }

  const out = new Uint8Array(a.byteLength + b.byteLength);

  out.set(a);
  out.set(b, a.byteLength);

  return out;
}
