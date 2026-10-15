import { expect, test } from 'bun:test';
import * as z from 'zod';
import { decodeBuildTrace } from '../images/decode-build-trace';
import { buildStubTracedBuild } from './build-stub-traced-build';

test('it streams the trace of a RUN step and then the image ID to a build', async () => {
  const answer = buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}` });

  const response = await answer(new Request('http://docker/build'), {
    method: 'POST',
    target: '/build?t=x',
    headers: {},
    body: new Uint8Array(),
    isBodyCut: false,
  });

  const text = await response?.text();

  const messages = (text ?? '')
    .trim()
    .split('\n')
    .map((line) => z.object({ id: z.string(), aux: z.unknown() }).parse(JSON.parse(line)));

  const traces = messages
    .filter((message) => message.id === 'moby.buildkit.trace')
    .map((message) => decodeBuildTrace(Buffer.from(String(message.aux), 'base64')));

  expect(traces.flatMap((trace) => trace.vertexes.map((vertex) => vertex.name))).toStrictEqual([
    '[2/3] RUN echo compiling widget && echo second line',
  ]);

  expect(
    traces.flatMap((trace) => trace.logs.map((log) => new TextDecoder().decode(log.msg))),
  ).toStrictEqual(['compiling widget\nsecond line\n']);

  expect(messages.at(-1)).toStrictEqual({
    id: 'moby.image.id',
    aux: { ID: `sha256:${'e'.repeat(64)}` },
  });
});

test('it holds the image ID until the hold settles', async () => {
  const hold = Promise.withResolvers<void>();
  const answer = buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}`, hold: hold.promise });

  const response = await answer(new Request('http://docker/build'), {
    method: 'POST',
    target: '/build?t=x',
    headers: {},
    body: new Uint8Array(),
    isBodyCut: false,
  });

  const reader = response?.body?.pipeThrough(new TextDecoderStream()).getReader();

  const first = await reader?.read();
  const second = await reader?.read();

  const rest = reader?.read();

  const pending = await Promise.race([rest, Promise.resolve('pending')]);

  hold.resolve();

  const last = await rest;

  expect(`${first?.value ?? ''}${second?.value ?? ''}`).toInclude('moby.buildkit.trace');
  expect(pending).toBe('pending');
  expect(last?.value).toInclude('moby.image.id');
});

test('it leaves a request that is no build to the engine defaults', async () => {
  const answer = buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}` });

  const response = await answer(new Request('http://docker/images/x/json'), {
    method: 'GET',
    target: '/images/x/json',
    headers: {},
    body: new Uint8Array(),
    isBodyCut: false,
  });

  expect(response).toBeNull();
});
