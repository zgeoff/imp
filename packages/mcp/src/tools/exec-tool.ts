import * as z from 'zod';
import { formatCappedText } from '../exec/output-cap';
import { runCapped } from '../exec/run-capped';
import { defineTool } from './define-tool';
import type { Tool } from './define-tool';
import { ImpNameInput } from './imp-tools';

const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1800;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

// the first bytes of a stream kept whole; the rest of the cap is its tail
const HEAD_BYTES = 8 * 1024;

const ExecInput = z
  .strictObject({
    name: ImpNameInput,
    command: z
      .string()
      .min(1)
      .optional()
      .describe('A shell command line, run as /bin/sh -c COMMAND. Give this or argv.'),
    argv: z
      .array(z.string())
      .min(1)
      .optional()
      .describe(
        'The program and its arguments, run as they are with no shell. Give this or command.',
      ),
    stdin: z
      .string()
      .optional()
      .describe("Text for the command's stdin, which then closes; closed at once when omitted"),
    cwd: z
      .string()
      .optional()
      .describe("The working directory; the image's workdir or HOME when omitted"),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables, added to the image's"),
    timeoutSeconds: z
      .int()
      .min(1)
      .max(MAX_TIMEOUT_S)
      .default(DEFAULT_TIMEOUT_S)
      .describe(
        `How long the command may run, waking the imp included (default ${String(DEFAULT_TIMEOUT_S)})`,
      ),
    maxOutputBytes: z
      .int()
      .min(1024)
      .max(MAX_OUTPUT_BYTES)
      .default(DEFAULT_OUTPUT_BYTES)
      .describe(
        `The most output kept per stream (default ${String(DEFAULT_OUTPUT_BYTES)}): the first ${String(HEAD_BYTES)} bytes and the last bytes, with a marker for the bytes dropped between`,
      ),
  })
  .refine((input) => (input.command === undefined) !== (input.argv === undefined), {
    message: 'give either command or argv',
  });

export const EXEC_TOOL: Tool = defineTool({
  name: 'imp_exec',
  description: [
    'Run a command in an imp and wait for it to exit. A sleeping imp wakes and a stopped one boots first.',
    'Returns the exit code, stdout and stderr. A non-zero exit is a normal result, not a tool error.',
    'At the timeout, or on a cancel, the command and every process it started get SIGTERM, then SIGKILL 2 s later; timedOut is then true.',
    'For a server or a job longer than the timeout, start it in the background and return at once: `nohup CMD >/tmp/job.log 2>&1 &`, then read the log with later calls. A process that calls setsid escapes the stop.',
  ].join(' '),
  input: ExecInput,
  annotations: {
    title: 'Run a command',
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  },
  run: async (input, context) => {
    context.guard.require(input.name);

    const result = await runCapped(context.client.openExec, input.name, {
      argv: input.argv ?? ['/bin/sh', '-c', input.command ?? ''],
      ...(input.stdin !== undefined && { stdin: new TextEncoder().encode(input.stdin) }),
      ...(input.cwd !== undefined && { cwd: input.cwd }),
      ...(input.env !== undefined && { env: input.env }),
      timeoutMs: input.timeoutSeconds * 1000,
      maxOutputBytes: input.maxOutputBytes,
      headBytes: Math.min(HEAD_BYTES, Math.floor(input.maxOutputBytes / 2)),
      signal: context.signal,
      killGraceMs: context.killGraceMs,
    });

    return {
      data: {
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        stdout: formatCappedText(result.stdout),
        stderr: formatCappedText(result.stderr),
        stdoutDroppedBytes: result.stdout.droppedBytes,
        stderrDroppedBytes: result.stderr.droppedBytes,
      },
    };
  },
});
