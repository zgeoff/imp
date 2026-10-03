import * as z from 'zod';

// an image manifest, as `docker push` writes it on either image store
const MANIFEST_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];

// the index type that matches its manifests' type
const INDEX_TYPES: Readonly<Record<string, string>> = {
  'application/vnd.oci.image.manifest.v1+json': 'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json':
    'application/vnd.docker.distribution.manifest.list.v2+json',
};

const MediaTypeSchema = z.object({ mediaType: z.string() });

interface IndexEntry {
  // a tag in the index's repository
  readonly tag: string;
  readonly architecture: string;
}

export interface PushIndexOptions {
  // host:port
  readonly registry: string;

  // the registry's certificate, PEM
  readonly ca: string;
  readonly repository: string;
  readonly tag: string;
  readonly entries: readonly IndexEntry[];
}

// Pushes an index of linux images under the tag, through the registry API:
// `docker manifest push` before Docker 29 speaks HTTP to a TLS registry, and
// `docker buildx imagetools` does not read /etc/docker/certs.d.
export async function writeRegistryIndex(options: Readonly<PushIndexOptions>): Promise<string> {
  const base = `https://${options.registry}/v2/${options.repository}/manifests`;
  const tls = { ca: options.ca };
  const manifests: unknown[] = [];
  let indexType = '';

  for (const entry of options.entries) {
    const response = await fetch(`${base}/${entry.tag}`, {
      headers: { Accept: MANIFEST_TYPES.join(', ') },
      tls,
    });

    if (!response.ok) {
      throw new Error(`GET ${base}/${entry.tag}: ${String(response.status)}`);
    }

    const body = await response.arrayBuffer();

    const bytes = new Uint8Array(body);

    const mediaType = MediaTypeSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).mediaType;
    const type = INDEX_TYPES[mediaType];

    if (type === undefined || (indexType !== '' && type !== indexType)) {
      throw new Error(`${options.repository}:${entry.tag} is a ${mediaType}`);
    }

    indexType = type;

    manifests.push({
      mediaType,
      digest: `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`,
      size: bytes.length,
      platform: { os: 'linux', architecture: entry.architecture },
    });
  }

  const index = JSON.stringify({ schemaVersion: 2, mediaType: indexType, manifests });

  const put = await fetch(`${base}/${options.tag}`, {
    method: 'PUT',
    headers: { 'Content-Type': indexType },
    body: index,
    tls,
  });

  if (!put.ok) {
    const reason = await put.text();

    throw new Error(`PUT ${base}/${options.tag}: ${String(put.status)} ${reason}`);
  }

  return `sha256:${new Bun.CryptoHasher('sha256').update(index).digest('hex')}`;
}
