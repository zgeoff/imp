import { onTestFinished } from 'bun:test';
import { Server } from 'ssh2';
import type { ServerChannel } from 'ssh2';
import { z } from 'zod';
import { createEd25519Key } from '../ssh/host-key';

interface StubSshServerOptions {
  // the one password the server takes; it refuses any other
  readonly password: string;
}

// An SSH server on loopback with one password. Each exec gets `exec.answer`
// in the open's packet burst; forwards are refused, as ssh2 does unhandled.
// At the test's end it stops listening; clients end their own connections.
export async function startStubSshServer(options: Readonly<StubSshServerOptions>) {
  const exec: { answer: (channel: ServerChannel) => void } = { answer: () => {} };
  const closes = { count: 0 };

  const server = new Server({ hostKeys: [createEd25519Key().private] }, (client) => {
    client.on('authentication', (auth) => {
      const isRight = auth.method === 'password' && auth.password === options.password;

      if (isRight) {
        auth.accept();
      } else {
        auth.reject(['password']);
      }
    });

    client.on('error', () => {});

    client.on('close', () => {
      closes.count += 1;
    });

    client.on('session', (acceptSession) => {
      const session = acceptSession();

      session.on('exec', (acceptExec) => {
        exec.answer(acceptExec());
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  // a server listening on a TCP port reports an object with its port
  const address = z.object({ port: z.number() }).parse(server.address());

  return { port: address.port, exec, closes };
}
