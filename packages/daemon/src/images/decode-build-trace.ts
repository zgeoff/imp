import { BinaryReader, WireType } from '@bufbuild/protobuf/wire';

// One vertex of a BuildKit build as a trace message reports it: a Dockerfile
// step such as `[2/5] RUN make`, or the frontend's own work
export interface TraceVertex {
  readonly digest: string;
  readonly name: string;
  readonly cached: boolean;
  readonly started: boolean;
  readonly completed: boolean;

  // empty for none
  readonly error: string;
}

// output a vertex wrote, in the chunks the engine sent
export interface TraceLog {
  readonly vertex: string;
  readonly msg: Uint8Array;
}

export interface BuildTrace {
  readonly vertexes: readonly TraceVertex[];
  readonly logs: readonly TraceLog[];
}

// The vertexes and logs of one `moby.buildkit.trace` message: BuildKit's
// control StatusResponse as protobuf (vertexes = 1, logs = 3). Statuses and
// warnings pass by, as do fields a newer BuildKit adds.
export function decodeBuildTrace(bytes: Uint8Array): BuildTrace {
  const reader = new BinaryReader(bytes);

  const vertexes: TraceVertex[] = [];
  const logs: TraceLog[] = [];

  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();

    if (field === 1 && wireType === WireType.LengthDelimited) {
      vertexes.push(decodeVertex(reader.bytes()));
    } else if (field === 3 && wireType === WireType.LengthDelimited) {
      logs.push(decodeLog(reader.bytes()));
    } else {
      reader.skip(wireType, field);
    }
  }

  return { vertexes, logs };
}

// Vertex: digest = 1, name = 3, cached = 4, started = 5, completed = 6,
// error = 7; a timestamp counts only as present
function decodeVertex(bytes: Uint8Array): TraceVertex {
  const reader = new BinaryReader(bytes);

  const vertex = {
    digest: '',
    name: '',
    cached: false,
    started: false,
    completed: false,
    error: '',
  };

  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();

    if (field === 1 && wireType === WireType.LengthDelimited) {
      vertex.digest = reader.string();
    } else if (field === 3 && wireType === WireType.LengthDelimited) {
      vertex.name = reader.string();
    } else if (field === 4 && wireType === WireType.Varint) {
      vertex.cached = reader.bool();
    } else if (field === 5 && wireType === WireType.LengthDelimited) {
      reader.bytes();

      vertex.started = true;
    } else if (field === 6 && wireType === WireType.LengthDelimited) {
      reader.bytes();

      vertex.completed = true;
    } else if (field === 7 && wireType === WireType.LengthDelimited) {
      vertex.error = reader.string();
    } else {
      reader.skip(wireType, field);
    }
  }

  return vertex;
}

// VertexLog: vertex = 1, msg = 4
function decodeLog(bytes: Uint8Array): TraceLog {
  const reader = new BinaryReader(bytes);

  const log: { vertex: string; msg: Uint8Array } = { vertex: '', msg: new Uint8Array() };

  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();

    if (field === 1 && wireType === WireType.LengthDelimited) {
      log.vertex = reader.string();
    } else if (field === 4 && wireType === WireType.LengthDelimited) {
      log.msg = reader.bytes();
    } else {
      reader.skip(wireType, field);
    }
  }

  return log;
}
