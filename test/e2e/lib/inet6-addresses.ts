// The IPv6 addresses in `ip -6 -o addr show` output, global and link scope;
// loopback (scope host) is left out.
export function parseInet6Addresses(shown: string): readonly string[] {
  return [...shown.matchAll(/ inet6 (?<address>[\da-f:]+)\/\d+ scope (?:global|link)/gv)].map(
    (match) => match.groups?.['address'] ?? '',
  );
}
