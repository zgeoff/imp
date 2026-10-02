import { connect } from 'node:net';

// how long one upstream has to answer before the next is asked
const UPSTREAM_TIMEOUT_MS = 2000;
const TC = 0x02_00;

// sends the query to an upstream resolver and returns its reply
export type DnsForward = (query: Uint8Array) => Promise<Uint8Array>;

// The upstreams in order (IMP_DNS, port 53 unless given), over UDP, and over
// TCP when a reply comes back truncated. A reply must carry the query's id.
export function createDnsForward(servers: readonly string[], port = 53): DnsForward {
  return async (query) => {
    const failures: string[] = [];

    for (const server of servers) {
      try {
        const reply = await sendUdp(server, port, query);

        if (((reply[2] ?? 0) * 256 + (reply[3] ?? 0)) & TC) {
          return await sendTcp(server, port, query);
        }

        return reply;
      } catch (error) {
        failures.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`no upstream resolver answered (${failures.join('; ')})`);
  };
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
