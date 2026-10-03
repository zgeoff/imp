import * as dnsPacket from 'dns-packet';
import type { Answer } from 'dns-packet';
import { findGuestSlot } from '../net/addressing';
import type { Subnet } from '../net/addressing';
import { readErrorMessage } from '../read-error-message';
import { EDE_PROHIBITED, RCODE, buildEmptyReply, buildLocalReply, readQuery } from './dns-messages';
import type { DnsForward } from './dns-upstream';
import { normalizeName } from './egress-rules';
import type { AddressAnswer } from './egress-sets';
import type { LocalAnswer } from './network-names';

// What the resolver does with a name: `admit` forwards it and lets the
// answer's addresses into the imp's set, `answer` forwards it and adds
// nothing (a host the broker serves), `refuse` never asks upstream.
export type QueryVerdict = 'admit' | 'answer' | 'refuse';

export interface RateLimit {
  readonly burst: number;
  readonly perSecond: number;
}

export interface ResolverDeps {
  readonly subnet: Subnet;

  // imps have IPv6: AAAA answers go into the sets as A answers do
  readonly ipv6?: boolean;

  // impd's own answer for a network name (network-names.ts), or null for a
  // name it passes on; asked before checkName, so one never goes upstream
  readonly resolveLocal: (
    slot: number,
    query: Readonly<{ name: string; type: string }>,
  ) => LocalAnswer | null;

  // null for a slot with no imp
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

  // a slot's query rate, which its policy sets
  readonly readRate: (slot: number) => RateLimit;
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
    const rate = deps.readRate(slot);
    const bucket = tokens.get(slot) ?? { level: rate.burst, at: now };
    const level = Math.min(rate.burst, bucket.level + ((now - bucket.at) / 1000) * rate.perSecond);

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
    const local = deps.resolveLocal(slot, { name, type: query.type });

    if (local !== null) {
      return local.kind === 'nxdomain'
        ? buildEmptyReply(message, RCODE.nxDomain)
        : buildLocalReply(query, local.records);
    }

    const verdict = await deps.checkName(slot, name);

    if (verdict === null || verdict === 'refuse') {
      return buildEmptyReply(message, RCODE.refused, EDE_PROHIBITED);
    }

    // without IPv6, guests have no route out for an AAAA answer
    if (query.type === 'AAAA' && deps.ipv6 !== true) {
      return buildEmptyReply(message, RCODE.noError);
    }

    try {
      const reply = await deps.forward(message);

      if (verdict === 'answer' || (query.type !== 'A' && query.type !== 'AAAA')) {
        return reply;
      }

      return await writeAnswers(deps, { slot, name, type: query.type }, reply);
    } catch (error) {
      deps.log(`impd: egress: ${name} for slot ${String(slot)}: ${readErrorMessage(error)}`);

      return buildEmptyReply(message, RCODE.servFail);
    }
  };
}

interface AddressQuery {
  readonly slot: number;
  readonly name: string;
  readonly type: 'A' | 'AAAA';
}

// The A or AAAA records on the CNAME chain from the name asked for go into
// the set, and every TTL in the reply drops to maxTtlS.
async function writeAnswers(
  deps: ResolverDeps,
  query: AddressQuery,
  reply: Uint8Array,
): Promise<Uint8Array> {
  const packet = dnsPacket.decode(Buffer.from(reply));
  const records = packet.answers ?? [];
  const chain = readChain(query.name, records);

  const answers: AddressAnswer[] = records.flatMap((record) =>
    (record.type === 'A' || record.type === 'AAAA') &&
    record.type === query.type &&
    chain.includes(normalizeName(record.name))
      ? [{ address: record.data, ttlS: record.ttl ?? 0 }]
      : [],
  );

  await deps.writeAnswers(query.slot, chain, answers);

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
interface ResolverServerLimits {
  readonly idleS: number;
  readonly maxPerSlot: number;
}

export interface ResolverServerOptions {
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly limits?: ResolverServerLimits;
}

// what a reply to a guest that went, or to a gateway with no route, gets
// back as ICMP: Bun marks it `errqueue`, and the guest just asked again
const ROUTINE_SOCKET_ERRORS = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

// one line per minute at most, with a count of the ones it held back
const SOCKET_ERROR_LOG_MS = 60_000;

// Bun 1.4.2 passes the error alone, not after the socket its types name
export function createSocketErrorReport(
  log: (message: string) => void,
  now: () => number,
): (...args: readonly unknown[]) => void {
  const state = { loggedAt: null as number | null, held: 0 };

  return (...args) => {
    const error = args.at(-1);

    if (checkRoutineSocketError(error)) {
      return;
    }

    const at = now();

    if (state.loggedAt !== null && at - state.loggedAt < SOCKET_ERROR_LOG_MS) {
      state.held += 1;

      return;
    }

    const held = state.held === 0 ? '' : ` (${String(state.held)} more since the last)`;

    log(`impd: egress: resolver socket: ${readErrorMessage(error)}${held}`);

    state.loggedAt = at;
    state.held = 0;
  };
}

function checkRoutineSocketError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const fields: { readonly errqueue?: unknown; readonly code?: unknown } = error;

  return fields.errqueue === true || ROUTINE_SOCKET_ERRORS.has(String(fields.code));
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
  options: Readonly<ResolverServerOptions>,
): Promise<ResolverServer> {
  const limits = options.limits ?? DEFAULT_TCP_LIMITS;

  const open = new Map<number, number>();

  const udp = await Bun.udpSocket({
    hostname: '0.0.0.0',
    port,
    socket: {
      data: (socket, data, remotePort, address) => {
        void sendUdpReply(handle, { socket, data, remotePort, address });
      },

      // an unhandled error would end impd; the ICMP error of a reply to a
      // guest that went is routine, anything else is logged
      error: createSocketErrorReport(options.log, options.now ?? Date.now),
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
