import { onTestFinished } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface StubSshAgentOptions {
  // `answer`: each request gets `agent:<request>` back; `hold`: connections
  // stay open and silent, as an agent busy with a confirmation prompt
  readonly mode: 'answer' | 'hold';
}

// A user's ssh-agent on a unix socket in a temp dir, gone when the test
// finishes. It speaks no agent protocol: the gateway relays bytes, so an
// echo with a prefix shows which way they went.
export async function startStubSshAgent(options: Readonly<StubSshAgentOptions>) {
  const dir = await mkdtemp(join(tmpdir(), 'imp-agent-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  const path = join(dir, 'agent.sock');

  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);

    socket.once('close', () => {
      sockets.delete(socket);
    });

    if (options.mode === 'answer') {
      socket.on('data', (data: Buffer) => {
        socket.write(`agent:${data.toString()}`);
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  // a held connection would keep the close waiting, so each one is ended
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });

        for (const socket of sockets) {
          socket.destroy();
        }
      }),
  );

  return { path };
}
