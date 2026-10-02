import type { EgressMode } from '@imp/api';

// The nftables table impd owns (docs/architecture/networking.md#the-firewall).
// It only drops and rejects: setup-net.sh's FORWARD rules still accept what
// it lets through, and a drop in any base chain is final.
const EGRESS_TABLE = 'inet imp_egress';

// open imps reach anything but these: cloud metadata services, and the
// shared range that holds the tailnet
const OPEN_BLOCKED_RANGES: readonly string[] = ['169.254.0.0/16', '100.64.0.0/10'];

// One slot's part of the table. `addresses` are what the resolver let in for
// a box; `cidrs` are its allow-list's address entries.
export interface FirewallSlot {
  readonly slot: number;
  readonly tap: string;
  readonly guestIp: string;
  readonly mode: EgressMode;
  readonly cidrs: readonly string[];
  readonly addresses: readonly string[];
}

export interface RulesetInput {
  readonly slots: readonly FirewallSlot[];

  // what a box may not reach unless its list names it: REFUSED_RANGES and
  // the imp subnet
  readonly privateRanges: readonly string[];
  readonly dnsPort: number;
  readonly setSize: number;
}

// The whole table, as one `nft -f` transaction: the empty table and the
// delete make the script work whether or not the table exists, on any
// kernel, and nothing is ever half applied.
export function buildRuleset(input: RulesetInput): string {
  const box = input.slots.filter((slot) => slot.mode === 'box');
  const redirected = input.slots.filter((slot) => slot.mode !== 'open');

  const lines = [
    `table ${EGRESS_TABLE} {}`,
    `delete table ${EGRESS_TABLE}`,
    `table ${EGRESS_TABLE} {`,
    ...buildSet('private', 'ipv4_addr', input.privateRanges, ['flags interval', 'auto-merge']),
    ...buildSet(
      'dns_taps',
      'ifname',
      redirected.map((slot) => formatTap(slot.tap)),
      [],
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
    '    meta nfproto ipv6 reject with icmpx admin-prohibited',
    '    iifname vmap @slots',

    // a tap with no slot
    '    goto deny',
    '  }',
    '  chain dns {',
    '    type nat hook prerouting priority dstnat - 1; policy accept;',
    `    iifname @dns_taps meta l4proto { tcp, udp } th dport 53 redirect to :${String(input.dnsPort)}`,
    '  }',
    '}',
  ];

  return `${lines.join('\n')}\n`;
}

// the resolver's additions and the sweep's deletions for one box slot
export function buildElementChange(
  verb: 'add' | 'delete',
  slot: number,
  addresses: readonly string[],
): string {
  return `${verb} element ${EGRESS_TABLE} allow${String(slot)} { ${addresses.join(', ')} }\n`;
}

// a box's two sets: what the resolver let in, and its list's CIDRs
function buildBoxSets(slot: FirewallSlot, setSize: number): readonly string[] {
  const id = String(slot.slot);

  return [
    ...buildSet(`allow${id}`, 'ipv4_addr', slot.addresses, [`size ${String(setSize)}`]),
    ...buildSet(`cidr${id}`, 'ipv4_addr', slot.cidrs, ['flags interval', 'auto-merge']),
  ];
}

// The slot's chain. Its first rule checks the source: a guest may send from
// another address of its /30, which the tap's reverse-path check passes.
function buildSlotChain(slot: FirewallSlot): readonly string[] {
  const id = String(slot.slot);

  const body: Record<EgressMode, readonly string[]> = {
    open: [`ip daddr { ${OPEN_BLOCKED_RANGES.join(', ')} } goto deny`, 'accept'],
    box: [
      'ct state invalid drop',
      'ct state established,related accept',
      `ip daddr @cidr${id} accept`,
      'ip daddr @private goto deny',
      `ip daddr @allow${id} accept`,
      'goto deny',
    ],
    none: ['goto deny'],
  };

  return [
    `  chain slot${id} {`,
    `    ip saddr != ${slot.guestIp} drop`,
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
