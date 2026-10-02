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

  // the one A record for the name, created or changed to this address
  readonly setA: (fqdn: string, ip: string) => Promise<void>;
}

export interface TxtRecord {
  readonly fqdn: string;
  readonly value: string;

  // the provider's own handle for the record, so removal hits only this one
  readonly id: string;
}
