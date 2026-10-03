import { connect } from 'node:net';
import { readErrorMessage } from '../read-error-message';

// how long one upstream has to answer before the next is asked
const UPSTREAM_TIMEOUT_MS = 2000;
const TC = 0x02_00;

// sends the query to an upstream resolver and returns its reply
export type DnsForward = (query: Uint8Array) => Promise<Uint8Array>;

// The upstreams in order (IMP_DNS, port 53 unless given), over UDP, then TCP
// for a truncated reply. A fresh random id per upstream query keeps a guest
// from choosing the id a forger must guess; the guest gets its own back.
export function createDnsForward(servers: readonly string[], port = 53): DnsForward {
  return async (guestQuery) => {
    const failures: string[] = [];

    for (const server of servers) {
      try {
        const query = toFreshId(guestQuery);

        const udpReply = await sendUdp(server, port, query);

        const reply =
          ((udpReply[2] ?? 0) * 256 + (udpReply[3] ?? 0)) & TC
            ? await sendTcp(server, port, query)
            : udpReply;

        if (reply[0] !== query[0] || reply[1] !== query[1]) {
          throw new Error('the reply is for another query');
        }

        return toGuestId(reply, guestQuery);
      } catch (error) {
        failures.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`no upstream resolver answered (${failures.join('; ')})`);
  };
}

function toFreshId(query: Uint8Array): Uint8Array {
  const copy = new Uint8Array(query);

  copy.set(crypto.getRandomValues(new Uint8Array(2)), 0);

  return copy;
}

function toGuestId(reply: Uint8Array, guestQuery: Uint8Array): Uint8Array {
  const copy = new Uint8Array(reply);

  copy.set(guestQuery.subarray(0, 2), 0);

  return copy;
}

async function sendUdp(server: string, port: number, query: Uint8Array): Promise<Uint8Array> {
  const reply = Promise.withResolvers<Uint8Array>();

  const socket = await Bun.udpSocket({
    socket: {
      data: (_socket, data, _port, address) => {
        // a reply from anywhere else, or for another id, is not this one
        if (address === server && data[0] === query[0] && data[1] === query[1]) {
          reply.resolve(new Uint8Array(data));
        }
      },

      // an upstream that refuses, as ICMP: the next one gets the query.
      // Bun 1.4.2 passes the error alone, not after the socket its types name.
      error: (...args: readonly unknown[]) => {
        const message = readErrorMessage(args.at(-1));

        reply.reject(new Error(message));
      },
    },
  });

  const timer = setTimeout(() => {
    reply.reject(new Error('timed out'));
  }, UPSTREAM_TIMEOUT_MS);

  try {
    socket.send(query, port, server);

    return await reply.promise;
  } finally {
    clearTimeout(timer);

    socket.close();
  }
}

// RFC 1035 4.2.2: each message has a two-byte length in front
function sendTcp(server: string, port: number, query: Uint8Array): Promise<Uint8Array> {
  const reply = Promise.withResolvers<Uint8Array>();
  const chunks: Buffer[] = [];

  const socket = connect({ host: server, port }, () => {
    const framed = Buffer.alloc(2 + query.byteLength);

    framed.writeUInt16BE(query.byteLength, 0);
    framed.set(query, 2);
    socket.write(framed);
  });

  socket.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
    socket.destroy(new Error('timed out'));
  });

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);

    const buffered = Buffer.concat(chunks);
    const length = buffered.byteLength >= 2 ? buffered.readUInt16BE(0) : -1;

    if (length >= 0 && buffered.byteLength >= 2 + length) {
      reply.resolve(new Uint8Array(buffered.subarray(2, 2 + length)));
      socket.end();
    }
  });

  socket.on('error', reply.reject);

  socket.on('close', () => {
    reply.reject(new Error('closed before a reply'));
  });

  return reply.promise;
}
