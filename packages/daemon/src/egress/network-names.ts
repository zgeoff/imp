import type { NetworkMember } from '../db/networks';
import { parseIpv4 } from '../net/addressing';
import type { Subnet } from '../net/addressing';

// impd's own answers for the names of imps on a network
// (docs/guides/networks.md#names): `<imp>.<network>.internal`, a peer's bare
// name, and the reverse names of IMP_SUBNET. They never go upstream.

// short, so a join or a leave shows in a guest's cache soon after
const LOCAL_TTL_S = 5;
const INTERNAL = 'internal';
const REVERSE_SUFFIX = '.in-addr.arpa';

interface LocalRecordBase {
  readonly name: string;
  readonly ttl: number;
  readonly data: string;
}

type LocalRecord =
  | (LocalRecordBase & { readonly type: 'A' })
  | (LocalRecordBase & { readonly type: 'PTR' });

// `records` empty is NOERROR with no data: the name exists, not this type
export type LocalAnswer =
  | { readonly kind: 'nxdomain' }
  | { readonly kind: 'records'; readonly records: readonly LocalRecord[] };

const NXDOMAIN: LocalAnswer = { kind: 'nxdomain' };

// what impd knows of the networks: every name, members or not
export interface NetworkView {
  readonly names: ReadonlySet<string>;
  readonly members: readonly NetworkMember[];
}

// impd's answer to a name from the guest in `slot`, or null for one it passes
// on, such as metadata.google.internal. Under a network that exists, a name
// the guest may not see is NXDOMAIN, as one that does not exist is.
export function resolveNetworkName(
  view: Readonly<NetworkView>,
  subnet: Subnet,
  query: Readonly<{ slot: number; name: string; type: string }>,
): LocalAnswer | null {
  const networks = new Set(
    view.members.filter((member) => member.slot === query.slot).map((member) => member.network),
  );

  const peers = view.members.filter((member) => networks.has(member.network));
  const labels = query.name.split('.');

  if (labels.at(-1) === INTERNAL && view.names.has(labels.at(-2) ?? '')) {
    const [imp, network] = labels;

    const peer =
      labels.length === 3
        ? peers.find((each) => each.name === imp && each.network === network)
        : undefined;

    return peer === undefined ? NXDOMAIN : buildAddressAnswer(query, peer.guestIp);
  }

  const reverse = readReverseAddress(query.name, subnet);

  if (reverse !== null) {
    return buildPointerAnswer(query, reverse, peers);
  }

  // no dot: a peer by its imp name, else what upstream says of it
  const peer = query.name.includes('.')
    ? undefined
    : peers.find((each) => each.name === query.name);

  return peer === undefined ? null : buildAddressAnswer(query, peer.guestIp);
}

function buildAddressAnswer(
  query: Readonly<{ name: string; type: string }>,
  address: string,
): LocalAnswer {
  const records: LocalRecord[] =
    query.type === 'A' ? [{ type: 'A', name: query.name, ttl: LOCAL_TTL_S, data: address }] : [];

  return { kind: 'records', records };
}

// a peer's address names it once for each network the guest shares with it
function buildPointerAnswer(
  query: Readonly<{ name: string; type: string }>,
  address: string,
  peers: readonly NetworkMember[],
): LocalAnswer {
  const named = peers.filter((peer) => peer.guestIp === address);

  if (named.length === 0) {
    return NXDOMAIN;
  }

  const records: LocalRecord[] =
    query.type === 'PTR'
      ? named.map((peer) => ({
          type: 'PTR',
          name: query.name,
          ttl: LOCAL_TTL_S,
          data: `${peer.name}.${peer.network}.${INTERNAL}`,
        }))
      : [];

  return { kind: 'records', records };
}

// For a reverse name inside the subnet: the address it names, or '' for one
// that names a range within it. Null for any other name.
function readReverseAddress(name: string, subnet: Subnet): string | null {
  if (!name.endsWith(REVERSE_SUFFIX)) {
    return null;
  }

  const octets = name.slice(0, -REVERSE_SUFFIX.length).split('.').toReversed();

  if (octets.length > 4) {
    return null;
  }

  const padded = [...octets, '0', '0', '0', '0'].slice(0, 4).join('.');
  const address = parseIpv4(padded);
  const hostBits = 32 - subnet.prefixLength;

  if (
    address === null ||
    octets.length * 8 < subnet.prefixLength ||
    Math.floor(address / 2 ** hostBits) !== Math.floor(subnet.network / 2 ** hostBits)
  ) {
    return null;
  }

  return octets.length === 4 ? padded : '';
}
