import * as dnsPacket from 'dns-packet';
import type { Answer } from 'dns-packet';
import { findGuestSlot } from '../net/addressing';
import type { Subnet } from '../net/addressing';
import { readErrorMessage } from '../read-error-message';
import { EDE_PROHIBITED, RCODE, buildEmptyReply, readQuery } from './dns-messages';
import type { DnsForward } from './dns-upstream';
import { normalizeName } from './egress-rules';
import type { AddressAnswer } from './egress-sets';

// What the resolver does with a name: `admit` forwards it and lets the
// answer's addresses into the imp's set, `answer` forwards it and adds
// nothing (a host the broker serves), `refuse` never asks upstream.
export type QueryVerdict = 'admit' | 'answer' | 'refuse';

export interface ResolverDeps {
  readonly subnet: Subnet;

  // null for a slot with no imp, or one whose imp is open
  readonly checkName: (slot: number, name: string) => Promise<QueryVerdict | null>;

  // resolves once the addresses are in nft
  readonly writeAnswers: (
    slot: number,
    names: readonly string[],
    answers: readonly AddressAnswer[],
  ) => Promise<void>;
  readonly forward: DnsForward;

  // the longest TTL a reply carries: a guest asks again within it, so an
  // impd restart, which empties the sets, costs a guest at most that long
  readonly maxTtlS: number;
  readonly rate: { readonly burst: number; readonly perSecond: number };
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export type QueryHandler = (source: string, message: Uint8Array) => Promise<Uint8Array>;

// One query from a guest to its reply. The verdict comes first, so a refused
// name never leaves the host, and the answer's addresses are in nft before
// the guest sees them.
export function createQueryHandler(deps: ResolverDeps): QueryHandler {
  const tokens = new Map<number, { level: number; at: number }>();

  // a bucket per slot: a burst, then perSecond
  const tryTakeToken = (slot: number): boolean => {
    const now = deps.now();
    const bucket = tokens.get(slot) ?? { level: deps.rate.burst, at: now };

    const level = Math.min(
      deps.rate.burst,
      bucket.level + ((now - bucket.at) / 1000) * deps.rate.perSecond,
    );

    if (level < 1) {
      tokens.set(slot, { level, at: now });

      return false;
    }

    tokens.set(slot, { level: level - 1, at: now });

    return true;
  };

  return async (source, message) => {
    const slot = findGuestSlot(source, deps.subnet);

    if (slot === null) {
      return buildEmptyReply(message, RCODE.refused, EDE_PROHIBITED);
    }

    // plain REFUSED, so a guest can tell a busy resolver from a denied name
    if (!tryTakeToken(slot)) {
      return buildEmptyReply(message, RCODE.refused);
    }

    const query = readQuery(message);

    if (query === null) {
      return buildEmptyReply(message, RCODE.refused);
    }

    const name = normalizeName(query.name);

    const verdict = await deps.checkName(slot, name);

    if (verdict === null || verdict === 'refuse') {
      return buildEmptyReply(message, RCODE.refused, EDE_PROHIBITED);
    }

    // guests have no IPv6 route out
    if (query.type === 'AAAA') {
      return buildEmptyReply(message, RCODE.noError);
    }

    try {
      const reply = await deps.forward(message);

      if (verdict === 'answer' || query.type !== 'A') {
        return reply;
      }

      return await writeAnswers(deps, slot, name, reply);
    } catch (error) {
      deps.log(`impd: egress: ${name} for slot ${String(slot)}: ${readErrorMessage(error)}`);

      return buildEmptyReply(message, RCODE.servFail);
    }
  };
}

// The A records on the CNAME chain from the name asked for go into the set,
// and every TTL in the reply drops to maxTtlS.
async function writeAnswers(
  deps: ResolverDeps,
  slot: number,
  name: string,
  reply: Uint8Array,
): Promise<Uint8Array> {
  const packet = dnsPacket.decode(Buffer.from(reply));
  const records = packet.answers ?? [];
  const chain = readChain(name, records);

  const answers: AddressAnswer[] = records.flatMap((record) =>
    record.type === 'A' && chain.includes(normalizeName(record.name))
      ? [{ address: record.data, ttlS: record.ttl ?? 0 }]
      : [],
  );

  await deps.writeAnswers(slot, chain, answers);

  return dnsPacket.encode({
    ...packet,
    answers: records.map((record) => toCappedTtl(record, deps.maxTtlS)),
  });
}

// the name and each CNAME target reached from it, in order
function readChain(name: string, records: readonly Answer[]): string[] {
  const chain = [name];

  for (;;) {
    const last = chain.at(-1);

    const next = records.find(
      (record) => record.type === 'CNAME' && normalizeName(record.name) === last,
    );

    if (next?.type !== 'CNAME') {
      return chain;
    }

    const target = normalizeName(next.data);

    if (chain.includes(target)) {
      return chain;
    }

    chain.push(target);
  }
}

function toCappedTtl(record: Answer, maxTtlS: number): Answer {
  return record.type === 'OPT' ? record : { ...record, ttl: Math.min(record.ttl ?? 0, maxTtlS) };
}

// a TCP client's idle time before the resolver closes it, and the
// connections one slot may hold open, as the broker caps them
const DEFAULT_TCP_LIMITS: ResolverServerLimits = { idleS: 10, maxPerSlot: 16 };

// smaller limits for tests
export interface ResolverServerLimits {
  readonly idleS: number;
  readonly maxPerSlot: number;
}

export interface ResolverServer {
  readonly port: number;
  readonly stop: () => void;
}

// UDP and TCP on every address of the host container: guests reach it on
// their gateway through the nat redirect of port 53, and setup-net.sh drops
// the port for anything but a guest.
export async function startResolverServer(
  port: number,
  subnet: Subnet,
  handle: QueryHandler,
  limits: ResolverServerLimits = DEFAULT_TCP_LIMITS,
): Promise<ResolverServer> {
  const open = new Map<number, number>();

  const udp = await Bun.udpSocket({
    hostname: '0.0.0.0',
    port,
    socket: {
      data: (socket, data, remotePort, address) => {
        void sendUdpReply(handle, { socket, data, remotePort, address });
      },
    },
  });

  const tcp = Bun.listen<{ buffered: Buffer; slot: number | null }>({
    hostname: '0.0.0.0',
    port: udp.port,
    socket: {
      open: (socket) => {
        const slot = findGuestSlot(socket.remoteAddress, subnet);
        const count = slot === null ? 0 : (open.get(slot) ?? 0);

        if (slot === null || count >= limits.maxPerSlot) {
          socket.data = { buffered: Buffer.alloc(0), slot: null };

          socket.end();

          return;
        }

        open.set(slot, count + 1);

        socket.data = { buffered: Buffer.alloc(0), slot };

        socket.timeout(limits.idleS);
      },
      timeout: (socket) => {
        socket.end();
      },
      close: (socket) => {
        const slot = socket.data.slot;

        if (slot === null) {
          return;
        }

        const left = (open.get(slot) ?? 1) - 1;

        if (left === 0) {
          open.delete(slot);
        } else {
          open.set(slot, left);
        }
      },
      data: (socket, chunk) => {
        if (socket.data.slot === null) {
          return;
        }

        socket.data.buffered = Buffer.concat([socket.data.buffered, chunk]);

        for (;;) {
          const buffered = socket.data.buffered;
          const length = buffered.byteLength >= 2 ? buffered.readUInt16BE(0) : -1;

          if (length < 0 || buffered.byteLength < 2 + length) {
            return;
          }

          const message = new Uint8Array(buffered.subarray(2, 2 + length));

          socket.data.buffered = buffered.subarray(2 + length);
          void sendTcpReply(handle, socket, message);
        }
      },
    },
  });

  return {
    port: udp.port,
    stop: () => {
      udp.close();
      tcp.stop(true);
    },
  };
}

interface UdpQuery {
  readonly socket: { readonly send: (data: Uint8Array, port: number, address: string) => boolean };
  readonly data: Uint8Array;
  readonly remotePort: number;
  readonly address: string;
}

async function sendUdpReply(handle: QueryHandler, query: UdpQuery): Promise<void> {
  const reply = await handle(query.address, new Uint8Array(query.data));

  query.socket.send(reply, query.remotePort, query.address);
}

interface TcpClient {
  readonly remoteAddress: string;
  readonly write: (data: Uint8Array) => number;
}

// RFC 1035 4.2.2: each message has a two-byte length in front
async function sendTcpReply(
  handle: QueryHandler,
  socket: TcpClient,
  message: Uint8Array,
): Promise<void> {
  const reply = await handle(socket.remoteAddress, message);

  const framed = Buffer.alloc(2 + reply.byteLength);

  framed.writeUInt16BE(reply.byteLength, 0);
  framed.set(reply, 2);
  socket.write(framed);
}
