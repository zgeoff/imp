import { expect, test } from 'bun:test';
import { ImageRefSchema } from './image-ref-schema';

test.each([
  ['ubuntu'],
  ['ubuntu:24.04'],
  ['library/ubuntu:latest'],
  ['imp/hello:latest'],
  ['ghcr.io/org/app:v1.2.3'],
  ['localhost:5000/team/app_x__y-z'],
  ['alpine@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  [
    'registry.example.com/a/b:tag@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ],
])('it accepts %s as an image reference', (ref) => {
  expect(ImageRefSchema.safeParse(ref).data).toBe(ref);
});

test.each([
  [''],
  ['-'],
  ['--help'],
  ['-v/:/host'],
  ['--output=/etc/passwd'],
  ['Ubuntu'],
  ['ubuntu:'],
  ['ubuntu:-latest'],
  ['/ubuntu'],
  ['ubuntu/'],
  ['a b'],
  ['ubuntu;rm -rf /'],
  ['ubuntu@sha256:short'],
])('it rejects %s as an image reference', (ref) => {
  const result = ImageRefSchema.safeParse(ref);

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({
      path: [],
      message: 'must be an image reference such as ubuntu:24.04 or ghcr.io/org/app@sha256:…',
    }),
  );
});

test('it rejects a reference longer than 255 characters', () => {
  const result = ImageRefSchema.safeParse('a'.repeat(256));

  expect(result.error?.issues).toPartiallyContain(
    expect.objectContaining({ path: [], code: 'too_big' }),
  );
});
