import { onTestFinished } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CommandIO } from '../command-io';
import { runCLI } from '../main';
import type { CliResult, StartCliOptions } from './start-cli';

// Runs one `impz` command line in this process as runCli runs the binary,
// with PATH, a HOME of its own unless the test names one, and piped stdin;
// its HOME goes when the test ends.
export async function runCLIInProcess(options: Readonly<StartCliOptions>): Promise<CliResult> {
  const home = mkdtempSync(join(tmpdir(), 'impz-cli-home-'));

  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const output = { stdout: '', stderr: '' };
  const piped = options.stdin === undefined ? [] : [Buffer.from(options.stdin)];

  const io: CommandIO = {
    env: { PATH: process.env['PATH'] ?? '', HOME: home, ...options.env },
    print: (line) => {
      output.stdout += `${line}\n`;
    },
    printError: (line) => {
      output.stderr += `${line}\n`;
    },
    writeOut: (chunk) => {
      output.stdout +=
        typeof chunk === 'string' ? chunk : decoders.stdout.decode(chunk, { stream: true });
    },
    writeErr: (chunk) => {
      output.stderr +=
        typeof chunk === 'string' ? chunk : decoders.stderr.decode(chunk, { stream: true });
    },
    isStdinTerminal: false,
    isStderrTerminal: false,
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    openStdin: () => Readable.from(piped),
  };

  const outcome = await runCLI(options.args, io);

  return { stdout: output.stdout, stderr: output.stderr, code: outcome.code };
}
