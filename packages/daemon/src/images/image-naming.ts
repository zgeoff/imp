import { NameSchema } from '@imp/api';
import * as z from 'zod';

const MAX_NAME_LENGTH = 31;

// The repository's last path segment as an imp image name:
// `ghcr.io/acme/web-app:1.2` → `web-app`, `ubuntu:24.04` → `ubuntu`.
export function deriveImageName(ref: string): string {
  const withoutDigest = ref.split('@')[0] ?? ref;
  const lastSegment = withoutDigest.split('/').at(-1) ?? withoutDigest;
  const repository = lastSegment.split(':')[0] ?? lastSegment;

  const name = repository
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/, '');

  if (!NameSchema.safeParse(name).success) {
    throw new Error(`cannot derive an image name from ${ref}; pass a name`);
  }

  return name;
}

const OciConfigSchema = z
  .object({
    Env: z.array(z.string()).nullish(),
    WorkingDir: z.string().nullish(),
    User: z.string().nullish(),
  })
  .nullish();

export interface ImageRuntimeConfig {
  readonly env: readonly string[];
  readonly workdir: string;
  readonly user: string;
}

// `docker image inspect` .Config → /etc/imp/image.json
// (docs/architecture/protocol.md#exec)
export function buildImageRuntimeConfig(ociConfig: unknown): ImageRuntimeConfig {
  const parsed = OciConfigSchema.parse(ociConfig);

  return {
    env: parsed?.Env ?? [],
    workdir: parsed?.WorkingDir ?? '',
    user: parsed?.User ?? '',
  };
}
