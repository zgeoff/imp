import * as z from 'zod';

// What impd reads of an image the build names, through one inspect
// format, so nothing else of the image reaches impd's logs.
export const PIN_INSPECT_FORMAT =
  '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"Config":{{json .Config}}}';

// The docker CLI renders a config with no triggers without the key, and a
// template that names it fails, so impd reads the whole config.
const ConfigSchema = z.object({ OnBuild: z.array(z.unknown()).readonly().nullish() }).nullable();

export const PinInspectSchema = z
  .object({
    Id: z.string(),
    RepoDigests: z.array(z.string()).readonly().nullable(),
    Os: z.string(),
    Architecture: z.string(),
    Config: ConfigSchema,
  })
  .transform((inspect) => ({
    Id: inspect.Id,
    RepoDigests: inspect.RepoDigests,
    Os: inspect.Os,
    Architecture: inspect.Architecture,
    OnBuild: inspect.Config?.OnBuild ?? null,
  }));

export type PinInspect = z.output<typeof PinInspectSchema>;

// the architecture names containerd's platforms.Normalize maps
const ARCHITECTURES = new Map([
  ['x86_64', 'amd64'],
  ['x86-64', 'amd64'],
  ['aarch64', 'arm64'],
  ['i386', '386'],
  ['i686', '386'],
]);

// `os/arch`, with the architecture named as containerd names it
export function formatPlatform(os: string, architecture: string): string {
  const arch = architecture.toLowerCase();

  return `${os.toLowerCase()}/${ARCHITECTURES.get(arch) ?? arch}`;
}

// The engine's platform. 32-bit arm needs a variant the engine's version
// does not give, so impd does not build there.
export function normalizePlatform(os: string, architecture: string): string {
  const platform = formatPlatform(os, architecture);

  if (!/^linux\/[a-z0-9]+$/v.test(platform) || platform === 'linux/arm') {
    throw new Error(
      `impd builds images on linux hosts other than 32-bit arm, not ${os}/${architecture.toLowerCase()}`,
    );
  }

  return platform;
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

export type ImageStore = 'containerd' | 'classic' | 'unknown';

// The engine's image store, read from an image: the containerd store's ID
// is a manifest or index digest, which RepoDigests holds; the classic
// store's is the config's, which it never does.
export function readImageStore(inspect: Readonly<PinInspect>): ImageStore {
  const digests = inspect.RepoDigests ?? [];

  if (digests.length === 0) {
    return 'unknown';
  }

  return digests.some((digest) => digest.endsWith(`@${inspect.Id}`)) ? 'containerd' : 'classic';
}

export interface Pin {
  readonly use: string;
  readonly ref: string;
  readonly pin: string;
}

const PULL_DENIED = /pull access denied|repository does not exist/v;

// A pinned build the engine could not resolve: on the containerd store, a
// retag of a multi-platform image has a digest under a name no registry has.
export function formatPinFailure(message: string, pins: readonly Pin[]): string {
  if (pins.length === 0 || !PULL_DENIED.test(message)) {
    return message;
  }

  const pinned = pins.map((entry) => `${entry.use} ${entry.ref} as ${entry.pin}`).join(', ');

  return `${message}\nimpd pinned ${pinned}. On the containerd image store a retag of a multi-platform image cannot be pinned: build FROM its original repository, such as busybox:1.37, instead of the retag.`;
}
