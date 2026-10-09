import { createFrameReader } from '../moves/move-frames';
import { MOVE_FINISH_HEADER, MOVE_PART_HEADER, MOVE_PATHS } from '../moves/move-header';
import type { FetchHook } from '../moves/test-moves';

// one frame of a move stream: its type byte and its payload
export interface MoveFrame {
  readonly type: number;
  readonly payload: Uint8Array;
}

// a frame whose payload is `value` as JSON, as the header, FILE, FILE_END
// and END frames carry theirs
export function buildJsonMoveFrame(type: number, value: unknown): MoveFrame {
  return { type, payload: new TextEncoder().encode(JSON.stringify(value)) };
}

// a frame as docs/architecture/moves.md#the-stream lays it out: the type
// byte, the payload's length as 4 bytes big-endian, the payload
function encodeMoveFrame(frame: Readonly<MoveFrame>): Uint8Array {
  const bytes = new Uint8Array(5 + frame.payload.length);
  const view = new DataView(bytes.buffer);

  view.setUint8(0, frame.type);
  view.setUint32(1, frame.payload.length);
  bytes.set(frame.payload, 5);

  return bytes;
}

async function readMoveFrames(body: Uint8Array): Promise<MoveFrame[]> {
  const reader = createFrameReader(new Blob([body]).stream());
  const frames: MoveFrame[] = [];

  for (let frame = await reader.readFrame(); frame !== null; frame = await reader.readFrame()) {
    frames.push(frame);
  }

  return frames;
}

// A faulty source: the first part's frames go through `rewrite`. The whole
// stream must fit that part, as a small imp's does at the default part size;
// a second part fails the send; other requests go as sent. It reads no host.
export function buildStubMoveStreamRewrite(
  rewrite: (frames: readonly MoveFrame[]) => readonly MoveFrame[],
): (request: Request, forward: Parameters<FetchHook>[1]) => Promise<Response> {
  return async (request, forward) => {
    const part = request.headers.get(MOVE_PART_HEADER);

    const isPart =
      request.url.endsWith(MOVE_PATHS.receive) && request.headers.get(MOVE_FINISH_HEADER) === null;

    if (!isPart) {
      return forward();
    }

    if (part !== '0') {
      throw new Error(
        `the stream rewrite needs the whole stream in part 0, not part ${String(part)}`,
      );
    }

    const sent = await request.arrayBuffer();
    const frames = await readMoveFrames(new Uint8Array(sent));

    const body = new Blob(rewrite(frames).map((frame) => encodeMoveFrame(frame)));

    return forward(new Request(request.url, { method: 'POST', headers: request.headers, body }));
  };
}
