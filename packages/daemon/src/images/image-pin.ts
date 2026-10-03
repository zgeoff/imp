import * as z from 'zod';

// What impd reads of an image the build names, through one inspect
// format, so nothing else of the image reaches impd's logs.
export const PIN_INSPECT_FORMAT =
  '{"RepoDigests":{{json .RepoDigests}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"OnBuild":{{json .Config.OnBuild}}}';

export const PinInspectSchema = z.object({
  RepoDigests: z.array(z.string()).readonly().nullable(),
  Os: z.string(),
  Architecture: z.string(),
  OnBuild: z.array(z.unknown()).readonly().nullable(),
});

export type PinInspect = z.infer<typeof PinInspectSchema>;

// the architecture names containerd's platforms.Normalize maps
const ARCHITECTURES = new Map([
  ['x86_64', 'amd64'],
  ['x86-64', 'amd64'],
  ['aarch64', 'arm64'],
  ['i386', '386'],
  ['i686', '386'],
]);

// The engine's platform, as `os/arch`. 32-bit arm needs a variant the
// engine's version does not give, so impd does not build there.
export function normalizePlatform(os: string, architecture: string): string {
  const arch = architecture.toLowerCase();
  const normalized = ARCHITECTURES.get(arch) ?? arch;

  if (os.toLowerCase() !== 'linux' || !/^[a-z0-9]+$/v.test(normalized) || normalized === 'arm') {
    throw new Error(`impd builds images on linux hosts other than 32-bit arm, not ${os}/${arch}`);
  }

  return `linux/${normalized}`;
}

// The repository a ref names, as docker writes it in RepoDigests:
// without its tag or digest, and docker.io's own names short.
export function toRepository(ref: string): string {
  const named = ref.split('@')[0] ?? ref;
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  const repository = colon > slash ? named.slice(0, colon) : named;
  const [first = '', ...rest] = repository.split('/');

  const hasDomain =
    rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');

  if (!hasDomain || (first !== 'docker.io' && first !== 'index.docker.io')) {
    return repository;
  }

  const path = rest.join('/');

  return rest.length === 2 && rest[0] === 'library' ? (rest[1] ?? path) : path;
}

// The digest ref the build names the image by: the ref's own digest, else
// a RepoDigest under the ref's repository, else any RepoDigest of the
// image, which holds the same content; null when the image has none.
export function pickRepoDigest(ref: string, repoDigests: readonly string[]): string | null {
  const repository = toRepository(ref);
  const [, written] = ref.split('@');

  if (written !== undefined) {
    return `${repository}@${written}`;
  }

  const own = repoDigests.find((entry) => entry.split('@')[0] === repository);

  return own ?? repoDigests[0] ?? null;
}
