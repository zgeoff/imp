// A TCP server on this machine that greets each connection and counts what
// it takes: guests reach it on the dev container's gateway, a private
// address. The caller stops it.
export interface HeldListener {
  readonly port: number;

  // the connections it accepted, and the bytes they sent
  readonly readAccepted: () => number;
  readonly readReceived: () => number;
  readonly stop: () => void;
}

export function startHeldListener(hostname: string): HeldListener {
  const counts = { accepted: 0, received: 0 };

  const listener = Bun.listen({
    hostname,
    port: 0,
    socket: {
      open: (socket) => {
        counts.accepted += 1;

        socket.write('hello\n');
      },
      data: (_socket, chunk) => {
        counts.received += chunk.byteLength;
      },
    },
  });

  return {
    port: listener.port,
    readAccepted: () => counts.accepted,
    readReceived: () => counts.received,
    stop: () => {
      listener.stop(true);
    },
  };
}
