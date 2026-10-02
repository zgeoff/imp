import type { EgressMode } from '@imp/api';

// The nftables table impd owns (docs/architecture/networking.md#the-firewall).
// It only drops and rejects: setup-net.sh's FORWARD rules still accept what
// it lets through, and a drop in any base chain is final.
const EGRESS_TABLE = 'inet imp_egress';
const NAT66_TABLE = 'ip6 imp_nat66';

// the packet mark of traffic between two imps on one network: setup-net.sh
// accepts it ahead of its imp-to-imp DROP. Set with an OR, so a bit someone
// else uses survives.
const PEER_MARK = '0x01000000';

// open imps reach anything but these: cloud metadata services, and the
// shared range that holds the tailnet
const OPEN_BLOCKED_RANGES: readonly string[] = ['169.254.0.0/16', '100.64.0.0/10'];

// One slot's part of the table. `addresses` are what the resolver let in for
// a box; `cidrs` are its allow-list's address entries. Both hold IPv4 and
// IPv6 alike; the table splits them by family.
export interface FirewallSlot {
  readonly slot: number;
  readonly tap: string;
  readonly guestIp: string;

  // the imp's IPv6 /128, or null when it has none
  readonly guestIp6: string | null;
  readonly mode: EgressMode;
  readonly cidrs: readonly string[];
  readonly addresses: readonly string[];
}

// one imp on a network, by the tap it sends from
export interface NetworkPeer {
  readonly tap: string;
  readonly guestIp: string;
}

export interface RulesetInput {
  readonly slots: readonly FirewallSlot[];

  // each network's imps, which reach one another whatever their policies
  readonly networks: readonly (readonly NetworkPeer[])[];

  // IMP_SUBNET: a query to an imp is for a peer's own DNS server
  readonly subnet: string;

  // the guests' resolvers (IMP_DNS): an open imp on a network asks impd
  // through them for its peers' names
  readonly dnsServers: readonly string[];

  // what a box may not reach unless its list names it: REFUSED_RANGES and
  // the imp subnet
  readonly privateRanges: readonly string[];

  // what no open or box imp reaches over IPv6, unless a box's list names
  // it: BLOCKED_RANGES6, the imps' /64 and the container's own prefixes
  readonly blocked6: readonly string[];
  readonly dnsPort: number;
  readonly setSize: number;
}

// The whole table, as one `nft -f` transaction: the empty table and the
// delete make the script work whether or not the table exists, on any
// kernel, and nothing is ever half applied.
export function buildRuleset(input: RulesetInput): string {
  const box = input.slots.filter((slot) => slot.mode === 'box');
  const redirected = input.slots.filter((slot) => slot.mode !== 'open');

  const peerTaps = new Set(input.networks.flatMap((peers) => peers.map((peer) => peer.tap)));

  const openPeers = input.slots.filter((slot) => slot.mode === 'open' && peerTaps.has(slot.tap));

  const lines = [
    `table ${EGRESS_TABLE} {}`,
    `delete table ${EGRESS_TABLE}`,
    `table ${EGRESS_TABLE} {`,
    ...buildSet('private', 'ipv4_addr', input.privateRanges, ['flags interval', 'auto-merge']),
    ...buildSet('blocked6', 'ipv6_addr', input.blocked6, ['flags interval', 'auto-merge']),
    ...buildSet(
      'dns_taps',
      'ifname',
      redirected.map((slot) => formatTap(slot.tap)),
      [],
    ),
    ...buildSet(
      'open_peer_taps',
      'ifname',
      openPeers.map((slot) => formatTap(slot.tap)),
      [],
    ),
    ...input.networks.flatMap((peers, index) =>
      buildSet(
        `net${String(index)}`,
        'ifname . ipv4_addr',
        peers.map((peer) => `${formatTap(peer.tap)} . ${peer.guestIp}`),
        [],
      ),
    ),
    ...box.flatMap((slot) => buildBoxSets(slot, input.setSize)),

    // A refusal: TCP gets a reset, which ends a live connection at once, as
    // after a flush of a tighter policy; ICMP alone leaves it retrying.
    '  chain deny {',
    '    meta l4proto tcp reject with tcp reset',
    '    reject with icmpx admin-prohibited',
    '  }',
    ...input.slots.flatMap((slot) => buildSlotChain(slot)),
    ...buildSet(
      'slots',
      'ifname : verdict',
      input.slots.map((slot) => `${formatTap(slot.tap)} : jump slot${String(slot.slot)}`),
      [],
      'map',
    ),
    '  chain forward {',
    '    type filter hook forward priority filter - 1; policy accept;',
    '    iifname != "imp*" accept',

    // both ends on one network, each from its own tap; any other imp to imp
    // packet, IPv6 included, is refused before a policy could accept it
    ...input.networks.map(
      (_peers, index) =>
        `    iifname . ip saddr @net${String(index)} oifname . ip daddr @net${String(index)} meta mark set meta mark | ${PEER_MARK} accept`,
    ),
    '    oifname "imp*" goto deny',
    '    iifname vmap @slots',

    // a tap with no slot
    '    goto deny',
    '  }',
    '  chain dns {',
    '    type nat hook prerouting priority dstnat - 1; policy accept;',

    // a query to an imp is for a peer's own server
    `    iifname @dns_taps meta nfproto ipv4 ip daddr != ${input.subnet} meta l4proto { tcp, udp } th dport 53 redirect to :${String(input.dnsPort)}`,
    ...(input.dnsServers.length === 0
      ? []
      : [
          `    iifname @open_peer_taps ip daddr { ${input.dnsServers.join(', ')} } meta l4proto { tcp, udp } th dport 53 redirect to :${String(input.dnsPort)}`,
        ]),
    '  }',
    '}',
  ];

  return `${lines.join('\n')}\n`;
}

// the resolver's additions and the sweep's deletions for one box slot, in
// allow<slot> for IPv4 and allow6<slot> for IPv6
export function buildElementChange(
  verb: 'add' | 'delete',
  slot: number,
  addresses: readonly string[],
): string {
  const [ipv4, ipv6] = splitFamilies(addresses);
  const id = String(slot);

  return [
    ipv4.length === 0 ? '' : `${verb} element ${EGRESS_TABLE} allow${id} { ${ipv4.join(', ')} }\n`,
    ipv6.length === 0 ? '' : `${verb} element ${EGRESS_TABLE} allow6${id} { ${ipv6.join(', ')} }\n`,
  ].join('');
}

// a box's sets, by family: what the resolver let in, and its list's CIDRs
function buildBoxSets(slot: FirewallSlot, setSize: number): readonly string[] {
  const id = String(slot.slot);
  const [addresses, addresses6] = splitFamilies(slot.addresses);
  const [cidrs, cidrs6] = splitFamilies(slot.cidrs);
  const size = [`size ${String(setSize)}`];
  const interval = ['flags interval', 'auto-merge'];

  return [
    ...buildSet(`allow${id}`, 'ipv4_addr', addresses, size),
    ...buildSet(`cidr${id}`, 'ipv4_addr', cidrs, interval),
    ...buildSet(`allow6${id}`, 'ipv6_addr', addresses6, size),
    ...buildSet(`cidr6${id}`, 'ipv6_addr', cidrs6, interval),
  ];
}

function splitFamilies(entries: readonly string[]): readonly [string[], string[]] {
  return [
    entries.filter((entry) => !entry.includes(':')),
    entries.filter((entry) => entry.includes(':')),
  ];
}

// The slot's chain. Its first rules check the source in each family: the
// tap's reverse-path check passes the rest of the guest's /30, and an `ip`
// rule never sees IPv6. Then the policy, for both families.
function buildSlotChain(slot: FirewallSlot): readonly string[] {
  const id = String(slot.slot);

  const body: Record<EgressMode, readonly string[]> = {
    open: [
      `ip daddr { ${OPEN_BLOCKED_RANGES.join(', ')} } goto deny`,
      'ip6 daddr @blocked6 goto deny',
      'accept',
    ],
    box: [
      'ct state invalid drop',
      'ct state established,related accept',
      `ip daddr @cidr${id} accept`,
      'ip daddr @private goto deny',
      `ip daddr @allow${id} accept`,
      `ip6 daddr @cidr6${id} accept`,
      'ip6 daddr @blocked6 goto deny',
      `ip6 daddr @allow6${id} accept`,
      'goto deny',
    ],
    none: ['goto deny'],
  };

  const source6 =
    slot.guestIp6 === null ? 'meta nfproto ipv6 drop' : `ip6 saddr != ${slot.guestIp6} drop`;

  return [
    `  chain slot${id} {`,
    `    ip saddr != ${slot.guestIp} drop`,
    `    ${source6}`,
    ...body[slot.mode].map((rule) => `    ${rule}`),
    '  }',
  ];
}

function buildSet(
  name: string,
  type: string,
  elements: readonly string[],
  options: readonly string[],
  kind: 'set' | 'map' = 'set',
): readonly string[] {
  return [
    `  ${kind} ${name} {`,
    `    type ${type}`,
    ...options.map((option) => `    ${option}`),
    ...(elements.length === 0 ? [] : [`    elements = { ${elements.join(', ')} }`]),
    '  }',
  ];
}

function formatTap(tap: string): string {
  return `"${tap}"`;
}

// NAT66 for a unique local prefix (docs/architecture/networking.md#ipv6), in
// a table of its own: written once at start, never with the egress table
// NAT66 gone, whether it was there or not: IPv6 off, or a routed /64
export function buildNat66Removal(): string {
  return `table ${NAT66_TABLE} {}\ndelete table ${NAT66_TABLE}\n`;
}

export function buildNat66Ruleset(prefix: string, uplink: string): string {
  return [
    `table ${NAT66_TABLE} {}`,
    `delete table ${NAT66_TABLE}`,
    `table ${NAT66_TABLE} {`,
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    oifname "${uplink}" ip6 saddr ${prefix} masquerade`,
    '  }',
    '}',
    '',
  ].join('\n');
}
