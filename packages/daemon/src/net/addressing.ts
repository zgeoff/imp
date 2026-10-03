import { deriveGuestIp6 } from './addressing6';
import type { Prefix64 } from './addressing6';

// Routed, not bridged (docs/architecture/networking.md#addressing): slot n owns
// the /30 at offset 4n of the subnet, with the host end at 4n+1 and the guest
// at 4n+2.

const SLOT_SIZE = 4;
const SLOT_PREFIX_LENGTH = 30;

export interface Subnet {
  readonly network: number;
  readonly prefixLength: number;
}

export interface SlotAddress {
  readonly slot: number;
  readonly tap: string;
  readonly hostIp: string;
  readonly guestIp: string;
  readonly prefixLength: number;
  readonly netmask: string;
  readonly guestMac: string;

  // the tap's: as the guest's, from the host IP
  readonly hostMac: string;

  // the imp's IPv6 /128, or null when imps get no IPv6
  // (docs/architecture/networking.md#ipv6)
  readonly guestIp6: string | null;

  // the imp's own port on the host (docs/architecture/networking.md#urls), for
  // the tailnet
  readonly tailnetPort: number;
}

export interface SlotPlan {
  readonly subnet: Subnet;
  readonly portBase: number;
  readonly prefix6?: Prefix64 | null;
}

export function parseSubnet(cidr: string): Subnet {
  const [address = '', prefixText = '', ...rest] = cidr.split('/');
  const parts = address.split('.');

  if (
    rest.length > 0 ||
    parts.length !== 4 ||
    ![...parts, prefixText].every((part) => isDecimal(part))
  ) {
    throw new Error(`subnet is not an IPv4 CIDR: ${cidr}`);
  }

  const octets = parts.map(Number);
  const prefix = Number(prefixText);

  if (octets.some((octet) => octet > 255)) {
    throw new Error(`subnet is not an IPv4 CIDR: ${cidr}`);
  }

  if (prefix < 8 || prefix > SLOT_PREFIX_LENGTH) {
    throw new Error(`subnet prefix must be between /8 and /30: ${cidr}`);
  }

  const network = octets.reduce((acc, octet) => acc * 256 + octet, 0);

  if (network % 2 ** (32 - prefix) !== 0) {
    throw new Error(`subnet has host bits set: ${cidr}`);
  }

  return { network, prefixLength: prefix };
}

// Tailscale's 100.64.0.0/10: a guest with an address in it would look like
// a tailnet peer to impd's tailnet identity
const TAILNET_NETWORK = 100 * 2 ** 24 + 64 * 2 ** 16;
const TAILNET_SIZE = 2 ** 22;

export function isTailnetOverlap(subnet: Subnet): boolean {
  const start = subnet.network;
  const end = start + 2 ** (32 - subnet.prefixLength);

  return start < TAILNET_NETWORK + TAILNET_SIZE && TAILNET_NETWORK < end;
}

export function countSlots(subnet: Subnet): number {
  return 2 ** (32 - subnet.prefixLength) / SLOT_SIZE;
}

export function deriveSlotAddress(slot: number, plan: SlotPlan): SlotAddress {
  if (!Number.isInteger(slot) || slot < 0 || slot >= countSlots(plan.subnet)) {
    throw new RangeError(`slot ${String(slot)} is outside the subnet`);
  }

  const base = plan.subnet.network + slot * SLOT_SIZE;
  const guest = base + 2;

  return {
    slot,
    tap: `imp${String(slot)}`,
    hostIp: formatIpv4(base + 1),
    guestIp: formatIpv4(guest),
    prefixLength: SLOT_PREFIX_LENGTH,
    netmask: '255.255.255.252',

    // locally administered unicast, then the guest IP: unique per slot and
    // readable in a packet capture
    guestMac: ['06', '00', ...splitOctets(guest).map((octet) => toHexByte(octet))].join(':'),
    hostMac: ['06', '01', ...splitOctets(base + 1).map((octet) => toHexByte(octet))].join(':'),
    guestIp6:
      plan.prefix6 === undefined || plan.prefix6 === null
        ? null
        : deriveGuestIp6(plan.prefix6, guest),
    tailnetPort: plan.portBase + slot,
  };
}

// A dotted IPv4 address as a number, or null for anything else (IPv6
// included). Node writes an IPv4 peer of a dual-stack socket as
// ::ffff:a.b.c.d; pass `allowMapped` to read that form as IPv4.
export function parseIpv4(text: string, allowMapped = false): number | null {
  const plain = allowMapped && text.startsWith('::ffff:') ? text.slice('::ffff:'.length) : text;
  const parts = plain.split('.');

  if (parts.length !== 4 || !parts.every((part) => isDecimal(part))) {
    return null;
  }

  const octets = parts.map(Number);

  if (octets.some((octet) => octet > 255)) {
    return null;
  }

  return octets.reduce((acc, octet) => acc * 256 + octet, 0);
}

// The slot whose /30 holds both ends of a connection: the guest end as the
// peer and the host end as the local address. Null when they are not one
// slot's pair, as when a guest dials another slot's gateway.
export function findPeerSlot(peer: string, local: string, subnet: Subnet): number | null {
  const peerIp = parseIpv4(peer, true);
  const localIp = parseIpv4(local, true);

  if (peerIp === null || localIp === null) {
    return null;
  }

  const offset = peerIp - subnet.network;

  if (offset < 0 || offset >= 2 ** (32 - subnet.prefixLength) || offset % SLOT_SIZE !== 2) {
    return null;
  }

  return localIp === peerIp - 1 ? (offset - 2) / SLOT_SIZE : null;
}

// The slot whose guest address this is; null for any other address, the
// other addresses of a slot's /30 included.
export function findGuestSlot(address: string, subnet: Subnet): number | null {
  const ip = parseIpv4(address, true);
  const offset = ip === null ? -1 : ip - subnet.network;

  if (offset < 0 || offset >= 2 ** (32 - subnet.prefixLength) || offset % SLOT_SIZE !== 2) {
    return null;
  }

  return (offset - 2) / SLOT_SIZE;
}

export function formatSubnet(subnet: Subnet): string {
  return `${formatIpv4(subnet.network)}/${String(subnet.prefixLength)}`;
}

// `a.b.c.d` or `a.b.c.d/n` as its network, host bits cleared
// (`172.17.0.2/16` is `172.17.0.0/16`); an address alone is a /32. Null for
// anything else.
export function formatCidr4(text: string): string | null {
  const [address = '', prefixText = '32', ...rest] = text.split('/');
  const ip = parseIpv4(address);
  const prefix = Number(prefixText);

  if (ip === null || rest.length > 0 || !/^\d{1,2}$/.test(prefixText) || prefix > 32) {
    return null;
  }

  return formatSubnet({ network: ip - (ip % 2 ** (32 - prefix)), prefixLength: prefix });
}

function isDecimal(text: string): boolean {
  return /^\d{1,3}$/.test(text);
}

function formatIpv4(address: number): string {
  return splitOctets(address).join('.');
}

function splitOctets(address: number): readonly number[] {
  return [
    Math.floor(address / 2 ** 24) % 256,
    Math.floor(address / 2 ** 16) % 256,
    Math.floor(address / 2 ** 8) % 256,
    address % 256,
  ];
}

function toHexByte(octet: number): string {
  return octet.toString(16).padStart(2, '0');
}
