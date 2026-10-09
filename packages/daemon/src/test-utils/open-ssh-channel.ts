import type { ClientChannel } from 'ssh2';

// everything a channel printed, and how it exited
interface ChannelResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: string | null;
}

type OpenCallback = (failure: Readonly<Error> | undefined, channel: ClientChannel) => void;

function collectResult(channel: ClientChannel): Promise<ChannelResult> {
  const out: { stdout: string; stderr: string; code: number | null; signal: string | null } = {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
  };

  channel.on('data', (data: Buffer) => {
    out.stdout += data.toString();
  });

  channel.stderr.on('data', (data: Buffer) => {
    out.stderr += data.toString();
  });

  channel.on('exit', (code: number | null, signal?: string) => {
    out.code = code;
    out.signal = signal ?? null;
  });

  return new Promise((resolve) => {
    channel.on('close', () => {
      resolve(out);
    });
  });
}

// Opens a channel through an ssh2 callback method, or rejects with its
// failure. Output is collected from the open on: `exit` can come in the
// open's packet, before a caller could listen. `result` settles on close.
export function openSshChannel(
  open: (done: OpenCallback) => void,
): Promise<{ readonly channel: ClientChannel; readonly result: Promise<ChannelResult> }> {
  return new Promise((resolve, reject) => {
    open((failure, channel) => {
      if (failure !== undefined) {
        reject(failure);

        return;
      }

      resolve({ channel, result: collectResult(channel) });
    });
  });
}
