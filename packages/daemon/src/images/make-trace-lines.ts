import { IMAGE_BUILD_LOG_MAX_CHARS } from '@imp/api';
import { createBuildSteps } from './create-build-steps';
import type { BuildOutput } from './create-build-steps';
import type { BuildTrace } from './decode-build-trace';

interface VertexState {
  readonly number: number;
  done: boolean;

  // the start of a line the next chunk ends
  partial: string;
}

// The lines `docker build --progress=plain` prints, from decoded trace
// messages: `#3 [2/5] RUN make`, then `#3 <line>` per line written, then
// `#3 DONE`, `CACHED` or `ERROR: …`; no timings, and each vertex starts once.
export function makeTraceLines(output: BuildOutput): (trace: BuildTrace) => void {
  const vertexes = new Map<string, VertexState>();

  const steps = createBuildSteps(output.setStep);

  const decoder = new TextDecoder();

  const emit = (state: VertexState, text: string): void => {
    output.emitLog(`#${String(state.number)} ${text}`.slice(0, IMAGE_BUILD_LOG_MAX_CHARS));
  };

  // a message's starts come before its logs, and its ends after them
  return (trace) => {
    for (const vertex of trace.vertexes) {
      if (!vertexes.has(vertex.digest) && (vertex.started || vertex.cached)) {
        const state = { number: vertexes.size + 1, done: false, partial: '' };

        vertexes.set(vertex.digest, state);

        emit(state, vertex.name);

        steps.start(vertex.digest, vertex.name);
      }
    }

    for (const log of trace.logs) {
      const state = vertexes.get(log.vertex);

      if (state === undefined) {
        continue;
      }

      const lines = (state.partial + decoder.decode(log.msg)).split(/\r?\n/v);

      state.partial = lines.pop() ?? '';

      for (const line of lines) {
        emit(state, line);
      }
    }

    for (const vertex of trace.vertexes) {
      const state = vertexes.get(vertex.digest);

      if (state === undefined || state.done || !(vertex.completed || vertex.cached)) {
        continue;
      }

      state.done = true;

      if (state.partial !== '') {
        emit(state, state.partial);

        state.partial = '';
      }

      const done = vertex.cached ? 'CACHED' : 'DONE';
      const end = vertex.error === '' ? done : `ERROR: ${vertex.error}`;

      emit(state, end);

      steps.end(vertex.digest);
    }
  };
}
