import { NameSchema } from '@imp/api';

export type DomainRoute =
  | { readonly kind: 'apex' }
  | { readonly kind: 'imp'; readonly name: string };

// What a Host header names on the HTTPS listeners: the bare domain is impd's
// own API, and exactly one label in front of it names an imp. `a.b.<domain>`
// or another domain is null, so no host outside the certificate reaches one.
export function parseDomainHost(host: string | null, domain: string): DomainRoute | null {
  if (host === null || host.startsWith('[')) {
    return null;
  }

  const hostname = host.replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();

  if (hostname === domain) {
    return { kind: 'apex' };
  }

  if (!hostname.endsWith(`.${domain}`)) {
    return null;
  }

  const label = hostname.slice(0, -(domain.length + 1));
  const parsed = NameSchema.safeParse(label);

  return parsed.success && !label.includes('.') ? { kind: 'imp', name: parsed.data } : null;
}
