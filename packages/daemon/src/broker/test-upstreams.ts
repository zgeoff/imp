import { readFileSync, statSync } from 'node:fs';
import { rootCertificates } from 'node:tls';
import * as z from 'zod';
import { readErrorMessage } from '../read-error-message';
import type { Upstream } from './forward-request';

// Tests only (IMP_BROKER_TEST_UPSTREAMS): a file that sends granted hosts to
// fake servers whose certificates verify against its extra CA; never a way
// to turn verification off. docs/guides/development.md has the format.

const FileSchema = z.object({
  ca: z.string().includes('-----BEGIN CERTIFICATE-----'),
  upstreams: z.record(z.string(), z.url({ protocol: /^https$/ })),
});

export type ResolveUpstream = (host: string) => Upstream;

export function createUpstreamResolver(
  path: string | null,
  log: (message: string) => void,
): ResolveUpstream {
  const cache: { mtimeMs: number; file: z.infer<typeof FileSchema> | null } = {
    mtimeMs: -1,
    file: null,
  };

  const readFile = (): z.infer<typeof FileSchema> | null => {
    if (path === null) {
      return null;
    }

    let mtimeMs: number;

    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      cache.mtimeMs = -1;
      cache.file = null;

      return null;
    }

    if (mtimeMs !== cache.mtimeMs) {
      cache.mtimeMs = mtimeMs;

      try {
        cache.file = FileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

        const hosts = Object.keys(cache.file.upstreams).join(', ');

        log(`impd: broker: warning: test upstreams from ${path} stand in for ${hosts}`);
      } catch (error) {
        cache.file = null;

        log(`impd: broker: ignoring ${path}: ${readErrorMessage(error)}`);
      }
    }

    return cache.file;
  };

  return (host) => {
    const file = readFile();
    const origin = file?.upstreams[host];

    if (file === null || origin === undefined) {
      return { origin: `https://${host}`, ca: null };
    }

    return { origin: origin.replace(/\/$/, ''), ca: [...rootCertificates, file.ca] };
  };
}
