import type { Readable, Writable } from 'node:stream';
import { ORPCError } from '@orpc/server';
import type { ServerChannel } from 'ssh2';
import { AgentError } from '../agent-client/agent-connection';
import type { DialStream } from '../agent-client/dial-stream';
import { readErrorMessage } from '../read-error-message';

// Where a channel's input goes: an exec's stdin or a dialed connection.
export interface ChannelSink {
  readonly write: (data: Uint8Array) => void;

  // resolves once what was written is on its way to the guest
  readonly drained: () => Promise<void>;

  // the client sent EOF
  readonly end: () => void;
}

// Client input to `sink`. The channel pauses until each chunk drained, so a
// guest that reads slower than the client sends holds back the client's SSH
// window instead of growing impd's memory.
export function startChannelInput(channel: Readable, sink: ChannelSink): void {
  const waitForDrain = async (): Promise<void> => {
    await sink.drained();

    channel.resume();
  };

  channel.on('data', (chunk: Buffer) => {
    sink.write(chunk);
    channel.pause();
    void waitForDrain();
  });

  channel.once('end', sink.end);
}

// Waits while the client's window is full. A closed channel ends the wait;
// the write is lost, as the client went away.
export async function writeToChannel(channel: Writable, data: Uint8Array): Promise<void> {
  if (channel.write(data) || channel.destroyed) {
    return;
  }

  await new Promise<void>((resolve) => {
    const stopWaiting = (): void => {
      channel.off('drain', stopWaiting);
      channel.off('close', stopWaiting);

      resolve();
    };

    channel.on('drain', stopWaiting);
    channel.on('close', stopWaiting);
  });
}

// Relays a channel and a dial-framed stream both ways until the agent
// closes it. The guest's EOF becomes the channel's EOF, and the client may
// still send. Port forwards and agent channels both run here.
export async function runChannelRelay(channel: ServerChannel, stream: DialStream): Promise<void> {
  startChannelInput(channel, stream);

  channel.once('close', stream.close);

  try {
    for await (const event of stream.events()) {
      if (event.type === 'data') {
        await writeToChannel(channel, event.data);
      } else {
        channel.eof();
      }
    }
  } finally {
    stream.close();
    channel.destroy();
  }
}

// what the client sees when an imp cannot wake or a program cannot start;
// the code first, as `imp` prints an API error
export function formatFailure(error: unknown): string {
  if (error instanceof AgentError) {
    return `${error.code}: ${error.detail}`;
  }

  if (error instanceof ORPCError) {
    return `${String(error.code)}: ${error.message}`;
  }

  return readErrorMessage(error);
}
