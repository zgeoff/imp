import type { StubEngineAnswer } from './start-stub-docker-engine';

export interface StubTracedBuildOptions {
  // the ID the build ends with
  readonly imageId: string;

  // the build holds after its trace until this settles; it ends at once
  // without one
  readonly hold?: Promise<void>;
}

// two `moby.buildkit.trace` messages a Docker 29.8 engine sent for
// `RUN echo compiling widget && echo second line`, the second of three
// Dockerfile steps: the step's start, then its two lines of output
const RECORDED_TRACE = [
  'CtQBCkdzaGEyNTY6MzhiZGNiOWVjNzI1YjA5MDFiNmU5ZWRlOWUxNmYxYzI2MDFiMmY4NTNjMWM3NzQ5MGQ0YTM2OWFlNjI5NDY4OBJHc2hhMjU2OjE5OGIxOTk0NWRhNGY3NWQ4Y2U1YTViZDhkYTIxZjJjMDFlYTljNzBhM2U2MGQzMmFkNWE5NzExMTFlMGE1MGUaM1syLzNdIFJVTiBlY2hvIGNvbXBpbGluZyB3aWRnZXQgJiYgZWNobyBzZWNvbmQgbGluZSoLCJDrwNYGEMawpnw=',
  'GngKR3NoYTI1NjozOGJkY2I5ZWM3MjViMDkwMWI2ZTllZGU5ZTE2ZjFjMjYwMWIyZjg1M2MxYzc3NDkwZDRhMzY5YWU2Mjk0Njg4EgwIkOvA1gYQ0uirpQIYASIdY29tcGlsaW5nIHdpZGdldApzZWNvbmQgbGluZQo=',
];

// The engine's answer to POST /build as a real build streams it: the
// recorded trace of a RUN step, then the image ID. Any other request goes
// to the stub engine's defaults.
export function buildStubTracedBuild(options: Readonly<StubTracedBuildOptions>): StubEngineAnswer {
  const encoder = new TextEncoder();

  return (_request, seen) => {
    if (!seen.target.startsWith('/build')) {
      return null;
    }

    const body = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        for (const aux of RECORDED_TRACE) {
          const message = { id: 'moby.buildkit.trace', aux };

          controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
        }

        await options.hold;

        const id = { id: 'moby.image.id', aux: { ID: options.imageId } };

        controller.enqueue(encoder.encode(`${JSON.stringify(id)}\n`));
        controller.close();
      },
    });

    return new Response(body);
  };
}
