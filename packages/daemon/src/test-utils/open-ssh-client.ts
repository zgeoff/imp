import { onTestFinished } from 'bun:test';
import { Client } from 'ssh2';
import type { ConnectConfig } from 'ssh2';

// A real ssh2 client logged in with `config`, ended when the test finishes;
// rejects with the client's error when the server refuses the login.
// oxlint-disable-next-line prefer-readonly-parameter-types -- ssh2's config holds mutable keys
export function openSshClient(config: ConnectConfig): Promise<Client> {
  const client = new Client();

  onTestFinished(() => {
    client.end();
  });

  return new Promise((resolve, reject) => {
    client.once('ready', () => {
      resolve(client);
    });

    // `on`: a refused client can emit a second error after the first
    client.on('error', reject);

    // ssh2 offers streamlocal only to a server named OpenSSH
    client.connect({ strictVendor: false, ...config });
  });
}
