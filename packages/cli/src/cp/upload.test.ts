import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EXEC_CHANNELS,
  EXEC_MAX_STDIN_FRAME_BYTES,
  EXEC_STDIN_WINDOW_BYTES,
  ExecClientMessageSchema,
  decodeExecFrame,
  encodeExecFrame,
} from '@imp/api';
import type { ExecServerMessage } from '@imp/api';
import type { ServerWebSocket } from 'bun';
import tar from 'tar-stream';
import type { CliConfig } from '../cli-config';
import type { CopyProgress } from './copy-progress';
import { openToolExec } from './open-tool-exec';
import { countFileBytes, listLocalEntries, writeLocalEntries } from './pack-local-path';

const TOKEN = 'cp-token';
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

interface FakeExec {
  readonly config: CliConfig;
  readonly started: unknown[];
  readonly stdin: Uint8Array[];
  readonly received: () => number;
  readonly ack: (bytes: number) => void;
}

function sendServer(ws: ServerWebSocket, message: ExecServerMessage): void {
  ws.send(JSON.stringify(message));
}

// An impd that serves only `/exec` for a tool: it records stdin, acks only
// when the test says, and exits 0 at stdin_eof. `fail` answers the start
// with an error instead.
function startFakeExec(fail: ExecServerMessage | null = null): FakeExec {
  const started: unknown[] = [];
  const stdin: Uint8Array[] = [];
  const sockets: ServerWebSocket[] = [];

  const server = Bun.serve({
    port: 0,
    fetch: (request, bunServer) => {
      if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }

      return bunServer.upgrade(request) ? undefined : new Response('', { status: 400 });
    },
    websocket: {
      message: (ws, message) => {
        sockets.push(ws);

        if (typeof message !== 'string') {
          const frame = decodeExecFrame(message);

          if (frame.channel === EXEC_CHANNELS.stdin) {
            stdin.push(Uint8Array.from(frame.data));
          }

          return;
        }

        const control = ExecClientMessageSchema.parse(JSON.parse(message));

        if (control.type === 'start') {
          started.push(control);

          if (fail === null) {
            sendServer(ws, { type: 'started', pid: 9 });
          } else {
            sendServer(ws, fail);

            ws.close(1011, 'exec failed');
          }
        } else if (control.type === 'stdin_eof') {
          ws.send(encodeExecFrame(EXEC_CHANNELS.stderr, new TextEncoder().encode('done\n')));

          sendServer(ws, { type: 'exit', code: 0, signal: null });

          ws.close(1000, 'exited');
        }
      },
    },
  });

  cleanups.push(() => {
    void server.stop(true);
  });

  return {
    config: { url: `http://127.0.0.1:${String(server.port)}`, token: TOKEN, host: null },
    started,
    stdin,
    received: () => stdin.reduce((total, chunk) => total + chunk.byteLength, 0),
    ack: (bytes) => {
      for (const ws of sockets.slice(0, 1)) {
        sendServer(ws, { type: 'stdin_ack', bytes });
      }
    },
  };
}

const quietProgress: CopyProgress = { setTotal: () => {}, add: () => {}, finish: () => {} };

async function readNames(archive: readonly Uint8Array[]): Promise<readonly string[]> {
  const extract = tar.extract();
  const names: string[] = [];

  const reading = (async () => {
    for await (const entry of extract) {
      names.push(
        `${entry.header.name} ${entry.header.type} ${(entry.header.mode & 0o777).toString(8)}`,
      );

      entry.resume();
    }
  })();

  for (const chunk of archive) {
    extract.write(chunk);
  }

  extract.end(null);

  await reading;

  return names;
}

test('a large upload stops at the stdin window until impd acks, and arrives whole', async () => {
  const fake = startFakeExec();
  const dir = mkdtempSync(join(tmpdir(), 'cp-up-'));

  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const top = join(dir, 'proj');

  mkdirSync(top, { mode: 0o750 });
  writeFileSync(join(top, 'big.bin'), new Uint8Array(4 * EXEC_STDIN_WINDOW_BYTES), { mode: 0o600 });
  symlinkSync('big.bin', join(top, 'link'));

  const entries = await listLocalEntries(top);

  const exec = await openToolExec({
    config: fake.config,
    name: 'box',
    tool: 'tar',
    args: ['extract', '/srv/proj'],
    onStdout: () => {},
    onStderr: () => {},
  });

  const writing = writeLocalEntries(entries, exec.writeStdin, quietProgress, () => {});

  await Bun.sleep(200);

  const held = fake.received();

  expect(held).toBeGreaterThan(EXEC_STDIN_WINDOW_BYTES);
  expect(held).toBeLessThanOrEqual(EXEC_STDIN_WINDOW_BYTES + EXEC_MAX_STDIN_FRAME_BYTES);
  expect(fake.stdin.every((chunk) => chunk.byteLength <= EXEC_MAX_STDIN_FRAME_BYTES)).toBeTrue();

  // ack everything as it comes, until the pack ends
  const acking = setInterval(() => {
    fake.ack(EXEC_STDIN_WINDOW_BYTES);
  }, 5);

  await writing;

  clearInterval(acking);

  exec.endStdin();

  const code = await exec.waitExit();
  const names = await readNames(fake.stdin);

  expect(code).toBe(0);
  expect(countFileBytes(entries)).toBe(4 * EXEC_STDIN_WINDOW_BYTES);

  expect(fake.started).toEqual([
    { type: 'start', name: 'box', tool: 'tar', argv: ['extract', '/srv/proj'], tty: false },
  ]);

  expect(names).toEqual(['proj/ directory 750', 'proj/big.bin file 600', 'proj/link symlink 777']);
});

test('impd refusing the exec reaches the caller as CODE: message', async () => {
  const fake = startFakeExec({
    type: 'error',
    code: 'AGENT_OUTDATED',
    message: "the imp's agent has no imp cp yet",
  });

  const failure = await openToolExec({
    config: fake.config,
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => {},
    onStderr: () => {},
  }).catch((error: unknown) => error);

  expect(String(failure)).toContain("AGENT_OUTDATED: the imp's agent has no imp cp yet");
});
