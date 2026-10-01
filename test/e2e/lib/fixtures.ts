import { join } from 'node:path';
import { listImageNames, runImp } from './imp-cli';
import { FIXTURES_DIR, REPO_ROOT } from './instance';
import type { FixtureImage } from './suites';

const BUILDS: Readonly<Record<FixtureImage, { readonly dir: string; readonly file?: string }>> = {
  base: { dir: join(REPO_ROOT, 'images', 'base') },
  'e2e-tiny': { dir: join(FIXTURES_DIR, 'tiny') },
  'e2e-bare': { dir: join(FIXTURES_DIR, 'tiny'), file: 'Dockerfile.bare' },
  'e2e-ws': { dir: join(FIXTURES_DIR, 'ws') },
};

// builds, through `imp image build`, each image impd does not have yet
export async function createMissingImages(images: readonly FixtureImage[]): Promise<void> {
  const names = await listImageNames();

  const have = new Set(names);

  for (const image of images) {
    if (have.has(image)) {
      continue;
    }

    const build = BUILDS[image];
    const fileArgs = build.file === undefined ? [] : ['--file', build.file];
    const started = Date.now();

    await runImp('image', 'build', build.dir, '--name', image, ...fileArgs);

    console.log(`    image ${image} built in ${String(Date.now() - started)} ms`);
  }
}
