// A Dockerfile impd will not build: the client's mistake.
export class DockerfileError extends Error {
  override name = 'DockerfileError';
}
