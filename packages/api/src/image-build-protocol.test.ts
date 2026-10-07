import { expect, test } from 'bun:test';
import {
  DockerfilePathSchema,
  ImageBuildErrorSchema,
  ImageBuildEventSchema,
  ImageBuildQuerySchema,
  ImageBuildResultSchema,
  ImageOpEventSchema,
} from './image-build-protocol';

test.each(['Dockerfile', 'docker/Dockerfile.dev', 'a..b/Dockerfile'])(
  '#DockerfilePathSchema accepts the path %s',
  (input) => {
    expect(DockerfilePathSchema.safeParse(input).data).toBe(input);
  },
);

test('#DockerfilePathSchema rejects an empty path', () => {
  const result = DockerfilePathSchema.safeParse('');

  expect(result.error?.issues).toPartiallyContain({ path: [], code: 'too_small' });
});

test.each(['/Dockerfile', '../Dockerfile', 'a/../../Dockerfile', String.raw`a\..\Dockerfile`])(
  '#DockerfilePathSchema rejects the path %s outside the context',
  (input) => {
    const result = DockerfilePathSchema.safeParse(input);

    expect(result.error?.issues).toPartiallyContain({
      path: [],
      message: 'the Dockerfile path must be relative and stay inside the build context',
    });
  },
);

test('#ImageBuildQuerySchema accepts a name and a Dockerfile path', () => {
  const payload = { name: 'web', dockerfile: 'docker/Dockerfile' } as const;

  expect(ImageBuildQuerySchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageBuildQuerySchema rejects a name that is not a valid name', () => {
  const result = ImageBuildQuerySchema.safeParse({ name: 'Web', dockerfile: 'docker/Dockerfile' });

  expect(result.error?.issues).toPartiallyContain({
    path: ['name'],
    message: 'must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens',
  });
});

test('#ImageBuildQuerySchema rejects an absolute Dockerfile path', () => {
  const result = ImageBuildQuerySchema.safeParse({ name: 'web', dockerfile: '/Dockerfile' });

  expect(result.error?.issues).toPartiallyContain({
    path: ['dockerfile'],
    message: 'the Dockerfile path must be relative and stay inside the build context',
  });
});

test('#ImageBuildResultSchema turns the date string into a date', () => {
  expect(
    ImageBuildResultSchema.safeParse({
      id: 'img-1',
      name: 'base',
      ref: 'docker.io/library/alpine:3',
      digest: 'sha256:abc',
      source: 'oci',
      createdAt: '2026-01-02T03:04:05.000Z',
      sizeBytes: 1_048_576,
    }).data,
  ).toStrictEqual({
    id: 'img-1',
    name: 'base',
    ref: 'docker.io/library/alpine:3',
    digest: 'sha256:abc',
    source: 'oci',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    sizeBytes: 1_048_576,
  });
});

test('#ImageBuildResultSchema rejects a date string that is not a date', () => {
  const result = ImageBuildResultSchema.safeParse({
    id: 'img-1',
    name: 'base',
    ref: 'docker.io/library/alpine:3',
    digest: 'sha256:abc',
    source: 'oci',
    createdAt: 'yesterday',
    sizeBytes: 1_048_576,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['createdAt'], code: 'invalid_type' });
});

test('#ImageBuildResultSchema rejects a source outside the source list', () => {
  const result = ImageBuildResultSchema.safeParse({
    id: 'img-1',
    name: 'base',
    ref: 'docker.io/library/alpine:3',
    digest: 'sha256:abc',
    source: 'docker',
    createdAt: '2026-01-02T03:04:05.000Z',
    sizeBytes: 1_048_576,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['source'], code: 'invalid_value' });
});

test('#ImageBuildErrorSchema accepts a code and a message', () => {
  const payload = { code: 'BUILD_FAILED', message: 'the build failed' } as const;

  expect(ImageBuildErrorSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageBuildEventSchema accepts a progress event', () => {
  const payload = { type: 'progress', phase: 'build', elapsedMs: 1500 } as const;

  expect(ImageBuildEventSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageBuildEventSchema accepts an image event with its date as a string', () => {
  expect(
    ImageBuildEventSchema.safeParse({
      type: 'image',
      image: {
        id: 'img-1',
        name: 'base',
        ref: 'docker.io/library/alpine:3',
        digest: 'sha256:abc',
        source: 'oci',
        createdAt: '2026-01-02T03:04:05.000Z',
        sizeBytes: 1_048_576,
      },
    }).data,
  ).toStrictEqual({
    type: 'image',
    image: {
      id: 'img-1',
      name: 'base',
      ref: 'docker.io/library/alpine:3',
      digest: 'sha256:abc',
      source: 'oci',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      sizeBytes: 1_048_576,
    },
  });
});

test('#ImageBuildEventSchema accepts an error event', () => {
  const payload = { type: 'error', code: 'BUILD_FAILED', message: 'the build failed' } as const;

  expect(ImageBuildEventSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageBuildEventSchema rejects an unknown event type', () => {
  const result = ImageBuildEventSchema.safeParse({ type: 'log', phase: 'build', elapsedMs: 1500 });

  expect(result.error?.issues).toPartiallyContain({ path: ['type'], code: 'invalid_union' });
});

test('#ImageBuildEventSchema rejects a phase outside the phase list', () => {
  const result = ImageBuildEventSchema.safeParse({
    type: 'progress',
    phase: 'push',
    elapsedMs: 1500,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['phase'], code: 'invalid_value' });
});

test('#ImageBuildEventSchema rejects a negative elapsed time', () => {
  const result = ImageBuildEventSchema.safeParse({
    type: 'progress',
    phase: 'build',
    elapsedMs: -1,
  });

  expect(result.error?.issues).toPartiallyContain({ path: ['elapsedMs'], code: 'too_small' });
});

test('#ImageOpEventSchema accepts a progress event', () => {
  const payload = { type: 'progress', phase: 'pull', elapsedMs: 0 } as const;

  expect(ImageOpEventSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageOpEventSchema accepts an image event', () => {
  const payload = {
    type: 'image',
    image: {
      id: 'img-1',
      name: 'base',
      ref: 'docker.io/library/alpine:3',
      digest: 'sha256:abc',
      source: 'oci',
      createdAt: new Date('2026-01-02T03:04:05.000Z'),
      sizeBytes: 1_048_576,
    },
  } as const;

  expect(ImageOpEventSchema.safeParse(payload).data).toStrictEqual(payload);
});

test('#ImageOpEventSchema rejects an image event with its date as a string', () => {
  const result = ImageOpEventSchema.safeParse({
    type: 'image',
    image: {
      id: 'img-1',
      name: 'base',
      ref: 'docker.io/library/alpine:3',
      digest: 'sha256:abc',
      source: 'oci',
      createdAt: '2026-01-02T03:04:05.000Z',
      sizeBytes: 1_048_576,
    },
  });

  expect(result.error?.issues).toPartiallyContain({
    path: ['image', 'createdAt'],
    code: 'invalid_type',
  });
});

test('#ImageOpEventSchema rejects an error event', () => {
  const result = ImageOpEventSchema.safeParse({ type: 'error', phase: 'pull', elapsedMs: 0 });

  expect(result.error?.issues).toPartiallyContain({ path: ['type'], code: 'invalid_union' });
});
