import { NameSchema } from '@impz/api';

// The imp a Host header names (docs/architecture/network/ingress.md#the-wake-proxy):
// the first label of `<name>.imp.localhost[:port]` or of any `<name>.<domain>`.
// A bare host, an IP address or a label that is no imp name gives null.
export function parseHostName(host: string | null): string | null {
  if (host === null || host.startsWith('[')) {
    return null;
  }

  const hostname = host.replace(/:\d+$/u, '').replace(/\.$/u, '').toLowerCase();
  const labels = hostname.split('.');

  if (labels.length < 2 || /^[\d.]+$/u.test(hostname)) {
    return null;
  }

  const parsed = NameSchema.safeParse(labels[0]);

  return parsed.success ? parsed.data : null;
}
