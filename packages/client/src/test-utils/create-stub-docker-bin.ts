import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// an image the engine has: its ID, and the files of a container made from it
export interface StubDockerImage {
  readonly id: string;
  readonly repoDigests: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}

// The docker CLI of an amd64 host engine with the Dockerfile frontend and
// `images` by reference (run-stub-docker.sh), for impd's host builds and adds;
// it pulls nothing, and any call it lacks fails and names itself
export function createStubDockerBin(
  dir: string,
  images: Readonly<Record<string, StubDockerImage>>,
) {
  const bin = join(dir, 'bin');
  const exports = join(dir, 'exports');
  const inspects = join(dir, 'inspect');
  const log = join(dir, 'docker.log');

  mkdirSync(bin, { recursive: true });
  mkdirSync(exports, { recursive: true });
  mkdirSync(inspects, { recursive: true });
  writeFileSync(log, '');

  const lines: string[] = [];

  for (const [ref, image] of Object.entries(images)) {
    const key = image.id.replace('sha256:', '');
    const tree = join(dir, 'trees', key);

    mkdirSync(tree, { recursive: true });

    for (const [name, content] of Object.entries(image.files)) {
      writeFileSync(join(tree, name), content);
    }

    Bun.spawnSync(['tar', '-C', tree, '-cf', join(exports, `${key}.tar`), '.']);

    writeFileSync(
      join(inspects, `${key}.json`),
      `${JSON.stringify([{ Id: image.id, Config: {}, Size: 1024, RepoDigests: image.repoDigests }])}\n`,
    );

    lines.push(`${ref} ${key}\n`);
  }

  writeFileSync(join(dir, 'images'), lines.join(''));
  copyFileSync(join(import.meta.dir, 'run-stub-docker.sh'), join(bin, 'docker'));
  chmodSync(join(bin, 'docker'), 0o755);

  return {
    // put it first on PATH
    binDir: bin,

    // each call's argv, oldest first
    readCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
