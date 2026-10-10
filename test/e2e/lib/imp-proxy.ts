import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { startImp } from './imp-cli';
import { waitFor } from './wait-for';

// Helpers for the proxy suites: `imp proxy` run as a user would, and TCP
// clients through it.

export const PAGE = 'e2e-tiny-ok\n';

// In the guest, on its loopback only: httpd on 9001, and on 9002 a server
// that answers only once the client half-closed, with the bytes it read.
export const GUEST_SERVERS = [
  'httpd -p 127.0.0.1:9001 -h /srv/www',
  String.raw`printf '#!/bin/sh\necho "got $(wc -c) bytes"\n' > /tmp/count`,
  'chmod +x /tmp/count',
  'setsid nc -lk -p 9002 -s 127.0.0.1 -e /tmp/count >/dev/null 2>&1 &',
].join('\n');

const decoder = new TextDecoder();

export interface RunningProxy {
  // the local port of each forward, in order
  readonly ports: readonly number[];
  readonly readStderr: () => string;
  readonly stop: () => Promise<number>;
}

interface OutputSink {
  text: string;
}

// oxlint-disable-next-line prefer-readonly-parameter-types -- the sink collects
async function collectOutput(stream: ReadableStream<Uint8Array>, sink: OutputSink): Promise<void> {
  for await (const chunk of stream) {
    sink.text += decoder.decode(chunk);
  }
}

// `imp proxy <name> <specs>`, once it printed a line for every forward
export async function startProxy(name: string, ...specs: readonly string[]): Promise<RunningProxy> {
  const proc = await startImp(['proxy', name, ...specs]);

  const stderr = { text: '' };
  const stdout = { text: '' };

  void collectOutput(proc.stderr, stderr);
  void collectOutput(proc.stdout, stdout);

  const ports = await waitFor('imp proxy to listen', () => {
    const found = [...stdout.text.matchAll(/forwarding localhost:(?<port>\d+) ->/gv)];

    if (found.length < specs.length) {
      throw new Error(`imp proxy printed ${stdout.text}${stderr.text}`);
    }

    return found.map((match) => Number(match.groups?.['port']));
  });

  return {
    ports,
    readStderr: () => stderr.text,
    stop: () => {
      proc.kill('SIGINT');

      return proc.exited;
    },
  };
}

// sends `body`, half-closes, and resolves with the reply once the far end
// closed
export function sendRequest(port: number, body: string): Promise<string> {
  const reply = Promise.withResolvers<string>();
  const socket = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  let text = '';

  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });

  socket.on('error', reply.reject);

  socket.on('close', () => {
    reply.resolve(text);
  });

  socket.end(body);

  return reply.promise;
}

export interface HeldSocket {
  readonly socket: Socket;
  readonly closed: Promise<void>;
}

export async function openHeldSocket(port: number): Promise<HeldSocket> {
  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const socket = connect({ host: '127.0.0.1', port }, connected.resolve);

  socket.on('error', () => {
    // a reset shows as the close
  });

  socket.on('close', () => {
    closed.resolve();
  });

  await connected.promise;

  return { socket, closed: closed.promise };
}

// writes `text` on a held socket and resolves with the first reply the far
// end sends; rejects when the socket closes first
export function sendOverHeldSocket(held: Readonly<HeldSocket>, text: string): Promise<string> {
  const reply = Promise.withResolvers<string>();

  if (held.socket.destroyed) {
    return Promise.reject(new Error('the held socket closed before a reply'));
  }

  held.socket.once('data', (chunk: Buffer) => {
    reply.resolve(chunk.toString());
  });

  held.socket.once('close', () => {
    reply.reject(new Error('the held socket closed before a reply'));
  });

  held.socket.write(text);

  return reply.promise;
}

export async function readPage(url: string): Promise<string> {
  const response = await fetch(url);

  return response.text();
}

export function countMatches(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
