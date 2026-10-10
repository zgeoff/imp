import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IMAGE_BUILD_PATH } from '../../../packages/api/src/image-build-protocol';

// A build context directory `<root>/<name>` holding this Dockerfile; returns
// its path. Other files go in beside it.
export async function writeBuildContext(
  root: string,
  name: string,
  dockerfile: string,
): Promise<string> {
  const dir = join(root, name);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'Dockerfile'), dockerfile);

  return dir;
}

export interface RawBuild {
  readonly apiUrl: string;
  readonly token: string;
  readonly dir: string;

  // the context's files, relative to dir, as the tar holds them
  readonly files: readonly string[];
  readonly name: string;
}

// A raw upload of a tar of `files` to impd's image build route, as an SDK
// sends it: the CLI packs only the Dockerfile it was told to, so the
// frontend's fallbacks need a tar of our own.
export async function sendRawBuild(build: Readonly<RawBuild>): Promise<Response> {
  const tar = Bun.spawn(['tar', '-C', build.dir, '-cf', '-', ...build.files], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [body, stderr, exitCode] = await Promise.all([
    new Response(tar.stdout).arrayBuffer(),
    new Response(tar.stderr).text(),
    tar.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`tar exited ${String(exitCode)}: ${stderr.trim()}`);
  }

  const url = new URL(IMAGE_BUILD_PATH, build.apiUrl);

  url.searchParams.set('name', build.name);

  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${build.token}`, 'content-type': 'application/x-tar' },
    body,
  });
}
