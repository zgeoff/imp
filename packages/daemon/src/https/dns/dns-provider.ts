// A DNS API impd writes records through: the TXT records of the ACME DNS-01
// challenge, and the A records that point the domain at the host.
export interface DnsProvider {
  // adds one TXT value next to any the name already has; ACME asks for two
  // values on `_acme-challenge.<domain>` at once, one per certificate name
  readonly addTxt: (fqdn: string, value: string) => Promise<TxtRecord>;
  readonly removeTxt: (record: TxtRecord) => Promise<void>;

  // resolves once every value answers from the zone's own nameservers, so
  // the CA's lookup finds them
  readonly waitForTxt: (fqdn: string, values: readonly string[]) => Promise<void>;

  // The one A record for the name, set to this address. The owner is its
  // comment, `managed by impd` unless it is a public imp's (buildPublicOwner);
  // a record with another comment is not this owner's to change.
  readonly setA: (fqdn: string, ip: string, owner?: string) => Promise<void>;

  // the A records under the domain with this owner, by name, to their address
  readonly listA: (domain: string, owner: string) => Promise<ReadonlyMap<string, string>>;

  // the name's A records with this owner; any other record stays
  readonly removeA: (fqdn: string, owner: string) => Promise<void>;
}

// Cloudflare keeps 100 characters of a comment
const MAX_OWNER_LENGTH = 100;

// The owner of the public imps' records for this domain. It names the
// domain, so an impd on dev.<domain> never removes the records of the impd
// on <domain>, and the other way round.
export function buildPublicOwner(domain: string): string {
  const owner = `impd public imps of ${domain}`;

  if (owner.length <= MAX_OWNER_LENGTH) {
    return owner;
  }

  const hash = new Bun.CryptoHasher('sha256').update(domain).digest('hex');

  return `impd public imps of sha256:${hash.slice(0, 32)}`;
}

export interface TxtRecord {
  readonly fqdn: string;
  readonly value: string;

  // the provider's own handle for the record, so removal hits only this one
  readonly id: string;
}
