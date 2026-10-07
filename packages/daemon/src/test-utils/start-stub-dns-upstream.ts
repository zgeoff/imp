import { buildMockDnsReply } from './build-mock-dns-message';
import type { MockDnsRecord } from './build-mock-dns-message';

// What the UDP side does with a query: answer it, answer with TC set and no
// records (the client must ask again over TCP), say nothing, or answer with
// an id one past the query's
export type StubDnsUdpMode = 'answer' | 'truncate' | 'drop' | 'wrong-id';

// What the TCP side does with a whole query: answer it, hold the
// connection open and say nothing, close it at once, or answer with the
// wrong id
export type StubDnsTcpMode = 'answer' | 'drop' | 'hang-up' | 'wrong-id';

interface StubDnsUpstreamOptions {
  // UDP and TCP on this one number: pick a free one (findFreePorts), since a
  // UDP bind to 0 and then TCP on its number can meet a TCP socket there
  readonly port: number;

  // the records every answer carries
  readonly answers?: readonly MockDnsRecord[];
  readonly udp?: StubDnsUdpMode;
  readonly tcp?: StubDnsTcpMode;
}

export interface StubDnsQueryRecord {
  readonly transport: 'udp' | 'tcp';
  readonly id: number;
}

function readId(query: Uint8Array): number {
  return ((query[0] ?? 0) << 8) | (query[1] ?? 0);
}

// An upstream DNS server on 127.0.0.1, over UDP and over TCP with RFC 1035's
// two-byte length in front of each message. `queries` holds each query it
// read, in order. A test picks each side's behaviour itself.
export async function startStubDnsUpstream(options: Readonly<StubDnsUpstreamOptions>) {
  const queries: StubDnsQueryRecord[] = [];
  const answers = options.answers ?? [];
  const udpMode = options.udp ?? 'answer';
  const tcpMode = options.tcp ?? 'answer';

  const buildReply = (query: Uint8Array, mode: StubDnsUdpMode | StubDnsTcpMode): Uint8Array =>
    buildMockDnsReply(query, {
      answers: mode === 'truncate' ? [] : answers,
      truncated: mode === 'truncate',
      id: mode === 'wrong-id' ? (readId(query) + 1) % 0x1_00_00 : readId(query),
    });

  const udp = await Bun.udpSocket({
    hostname: '127.0.0.1',
    port: options.port,
    socket: {
      data: (socket, data, port, address) => {
        const query = new Uint8Array(data);

        // the reply goes before the query shows in `queries`
        if (udpMode !== 'drop') {
          socket.send(buildReply(query, udpMode), port, address);
        }

        queries.push({ transport: 'udp', id: readId(query) });
      },
    },
  });

  const tcp = Bun.listen<{ buffered: Buffer }>({
    hostname: '127.0.0.1',
    port: options.port,
    socket: {
      open: (socket) => {
        socket.data = { buffered: Buffer.alloc(0) };
      },
      data: (socket, chunk) => {
        socket.data.buffered = Buffer.concat([socket.data.buffered, chunk]);

        // each whole message in what has come, as several may share a chunk
        for (;;) {
          const buffered = socket.data.buffered;
          const length = buffered.byteLength >= 2 ? buffered.readUInt16BE(0) : -1;

          if (length < 0 || buffered.byteLength < 2 + length) {
            return;
          }

          const query = new Uint8Array(buffered.subarray(2, 2 + length));

          socket.data.buffered = buffered.subarray(2 + length);

          if (tcpMode === 'hang-up') {
            socket.end();
          } else if (tcpMode !== 'drop') {
            const reply = buildReply(query, tcpMode);
            const framed = Buffer.alloc(2 + reply.byteLength);

            framed.writeUInt16BE(reply.byteLength, 0);
            framed.set(reply, 2);
            socket.write(framed);
          }

          queries.push({ transport: 'tcp', id: readId(query) });
        }
      },
    },
  });

  return {
    port: udp.port,
    queries: queries as readonly StubDnsQueryRecord[],
    [Symbol.dispose]: (): void => {
      udp.close();
      tcp.stop(true);
    },
  };
}
