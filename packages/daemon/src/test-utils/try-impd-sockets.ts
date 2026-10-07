// WebSocket clients for impd's /exec and /tunnel, for tests

// opens /exec with `query` and reports whether the upgrade succeeded; a
// session it opens sends `start` for `name` and reports the first message, or
// 'closed' when the server closes it before sending one
export async function tryExecSocket(
  port: string,
  query: string,
  name = 'dev',
  headers: Readonly<Record<string, string>> = {},
) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/exec?${query}`, { headers });

  const outcome = Promise.withResolvers<string>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', name, argv: ['true'], tty: false }));
  });

  socket.addEventListener('message', (event) => {
    outcome.resolve(String(event.data));
  });

  socket.addEventListener('error', () => {
    outcome.resolve('rejected');
  });

  // a refused upgrade fires error before close, so it stays 'rejected'
  socket.addEventListener('close', () => {
    outcome.resolve('closed');
  });

  try {
    return await outcome.promise;
  } finally {
    socket.close();
  }
}

// opens /tunnel and reports the first message for `open`, 'rejected', or
// 'closed' when the server closes it before sending one
export async function tryTunnelSocket(
  port: string,
  query: string,
  headers: Readonly<Record<string, string>>,
  name = 'nope',
): Promise<string> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/tunnel?${query}`, { headers });

  const outcome = Promise.withResolvers<string>();

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'open', name, port: 5432 }));
  });

  socket.addEventListener('message', (event) => {
    outcome.resolve(String(event.data));
  });

  socket.addEventListener('error', () => {
    outcome.resolve('rejected');
  });

  // a refused upgrade fires error before close, so it stays 'rejected'
  socket.addEventListener('close', () => {
    outcome.resolve('closed');
  });

  try {
    return await outcome.promise;
  } finally {
    socket.close();
  }
}
