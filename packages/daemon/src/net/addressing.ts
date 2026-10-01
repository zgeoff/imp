// Routed, not bridged (DESIGN 2.6): slot n owns the /30 at offset 4n of the
// subnet, with the host end at 4n+1 and the guest at 4n+2.

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
  readonly proxyPort: number;
}

export interface SlotPlan {
  readonly subnet: Subnet;
  readonly portBase: number;
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
    proxyPort: plan.portBase + slot,
  };
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
