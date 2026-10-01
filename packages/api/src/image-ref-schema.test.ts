import { expect, test } from 'bun:test';
import { ImageRefSchema } from './image-ref-schema';

const DIGEST = `sha256:${'a'.repeat(64)}`;

test('it accepts OCI image references', () => {
  for (const ref of [
    'ubuntu',
    'ubuntu:24.04',
    'library/ubuntu:latest',
    'imp/dev:latest',
    'ghcr.io/org/app:v1.2.3',
    'localhost:5000/team/app_x__y-z',
    `alpine@${DIGEST}`,
    `registry.example.com/a/b:tag@${DIGEST}`,
  ]) {
    expect(ImageRefSchema.safeParse(ref).success).toBe(true);
  }
});

test('it rejects anything docker could read as a flag or that is not a reference', () => {
  for (const ref of [
    '',
    '-',
    '--help',
    '-v/:/host',
    '--output=/etc/passwd',
    'Ubuntu',
    'ubuntu:',
    'ubuntu:-latest',
    '/ubuntu',
    'ubuntu/',
    'a b',
    'ubuntu;rm -rf /',
    'ubuntu@sha256:short',
    'a'.repeat(256),
  ]) {
    expect(ImageRefSchema.safeParse(ref).success).toBe(false);
  }
});
