// The Dockerfile frontend every image build runs, by digest; BUILDKIT_SYNTAX
// wins over a `# syntax=` line. The same pin as host/Dockerfile's first
// line: bump both at once.
export const DOCKERFILE_FRONTEND =
  'docker/dockerfile:1.19@sha256:b6afd42430b15f2d2a4c5a02b919e98a525b785b1aaff16747d2f623364e39b6';
