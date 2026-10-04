import * as z from 'zod';
import { formatCappedText } from '../exec/output-cap';
import { runCapped } from '../exec/run-capped';
import type { CappedRunResult } from '../exec/run-capped';
import { defineTool } from './define-tool';
import type { Tool, ToolContext } from './define-tool';
import { ImpNameInput } from './imp-tools';

const DEFAULT_READ_BYTES = 256 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const FILE_TIMEOUT_MS = 60_000;

// the little a failed command prints on stderr
const STDERR_BYTES = 4096;

// Absolute, so no path reaches a command as a flag; the commands take it as
// an argument, never inside a shell string.
const GuestPathInput = z
  .string()
  .startsWith('/', 'must be an absolute path')
  .describe('An absolute path in the imp');

const MaxBytesInput = z
  .int()
  .min(1)
  .max(MAX_READ_BYTES)
  .default(DEFAULT_READ_BYTES)
  .describe(
    `The most bytes to read (default ${String(DEFAULT_READ_BYTES)}); a larger file fails, so read a part of it with imp_exec (head, tail, sed -n)`,
  );

const EncodingInput = z
  .enum(['utf8', 'base64'])
  .default('utf8')
  .describe('utf8 for text, base64 for any bytes (default utf8)');

// Writes stdin to "$1", through a symlink, by a temp file and a rename, so no
// reader sees half a file. An existing file keeps its mode, a new one gets
// 0666 less the umask. Each command works in coreutils and BusyBox alike.
export const WRITE_SCRIPT = [
  'set -e',

  // any exit before the content is read still reads it: the writer must not
  // meet a closed pipe, whose EPIPE would hide this exit and its message
  "trap 'cat >/dev/null' EXIT",
  'target=$1',
  'if [ -L "$target" ]; then',
  '  target=$(readlink -f "$target") || { echo "cannot resolve the symlink $1" >&2; exit 1; }',
  'fi',
  'if [ -d "$target" ]; then echo "$1 is a directory" >&2; exit 1; fi',
  'dir=$(dirname "$target")',
  'mkdir -p "$dir"',
  'tmp=$(mktemp "$dir/.imp-write.XXXXXX")',
  'trap \'rm -f "$tmp"; cat >/dev/null\' EXIT',
  'cat > "$tmp"',
  'if [ -e "$target" ]; then mode=$(stat -c %a "$target"); else mode=$(printf %o $((0666 & ~$(umask)))); fi',
  'chmod "$mode" "$tmp"',
  'mv -f "$tmp" "$target"',
  'trap - EXIT',
].join('\n');

export const FILE_TOOLS: readonly Tool[] = [
  defineTool({
    name: 'imp_read_file',
    scope: 'exec',
    description: `Read a file in an imp, up to maxBytes. A sleeping imp wakes and a stopped one boots first. Text comes back as utf8; a file that is not valid UTF-8 fails, so read it again with encoding base64.`,
    input: z.strictObject({
      name: ImpNameInput,
      path: GuestPathInput,
      encoding: EncodingInput,
      maxBytes: MaxBytesInput,
    }),
    annotations: { title: 'Read a file', readOnlyHint: true, openWorldHint: false },
    run: async (input, context) => {
      context.guard.require(input.name);

      // one byte past the limit tells a file at the limit from a larger one
      const result = await runFileCommand(context, input.name, {
        argv: ['head', '-c', String(input.maxBytes + 1), input.path],
        maxOutputBytes: input.maxBytes + 1,
      });

      const failed = formatFailure(result, `could not read ${input.path}`);

      if (failed !== null) {
        return { data: { path: input.path }, failed };
      }

      const bytes = result.stdout.head;

      if (bytes.byteLength > input.maxBytes) {
        return {
          data: { path: input.path },
          failed: `${input.path} is larger than maxBytes (${String(input.maxBytes)}); read a part of it with imp_exec`,
        };
      }

      const content = encodeContent(bytes, input.encoding);

      if (content === null) {
        return {
          data: { path: input.path, bytes: bytes.byteLength },
          failed: `${input.path} is not valid UTF-8; read it with encoding base64`,
        };
      }

      return {
        data: { path: input.path, encoding: input.encoding, bytes: bytes.byteLength, content },
      };
    },
  }),
  defineTool({
    name: 'imp_write_file',
    scope: 'exec',
    description: `Write a file in an imp, replacing it whole, and create its parent directories. The write goes to a temp file that is renamed over the path, so no reader sees half a file; an existing file keeps its mode, a symlink is written through, and a directory is refused. At most ${String(MAX_WRITE_BYTES)} bytes.`,
    input: z.strictObject({
      name: ImpNameInput,
      path: GuestPathInput,
      content: z.string().describe('The whole file, as text or as base64 (see encoding)'),
      encoding: EncodingInput,
    }),
    annotations: {
      title: 'Write a file',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    run: async (input, context) => {
      context.guard.require(input.name);

      const bytes = decodeContent(input.content, input.encoding);

      if (bytes.byteLength > MAX_WRITE_BYTES) {
        throw new Error(
          `the content is ${String(bytes.byteLength)} bytes; the most is ${String(MAX_WRITE_BYTES)}`,
        );
      }

      const result = await runFileCommand(context, input.name, {
        argv: ['/bin/sh', '-c', WRITE_SCRIPT, 'sh', input.path],
        stdin: bytes,
        maxOutputBytes: STDERR_BYTES,
      });

      const failed = formatFailure(result, `could not write ${input.path}`);

      if (failed !== null) {
        return { data: { path: input.path }, failed };
      }

      return { data: { path: input.path, bytes: bytes.byteLength } };
    },
  }),
];

interface FileCommand {
  readonly argv: readonly string[];
  readonly stdin?: Uint8Array;
  readonly maxOutputBytes: number;
}

// head only: past the cap is either too large (read) or noise (write)
function runFileCommand(
  context: Readonly<ToolContext>,
  name: string,
  command: Readonly<FileCommand>,
): Promise<CappedRunResult> {
  return runCapped(context.client.openExec, name, {
    ...command,
    timeoutMs: FILE_TIMEOUT_MS,
    headBytes: command.maxOutputBytes,
    signal: context.signal,
    killGraceMs: context.killGraceMs,
  });
}

function formatFailure(result: Readonly<CappedRunResult>, what: string): string | null {
  if (result.timedOut) {
    return `${what}: timed out after ${String(FILE_TIMEOUT_MS / 1000)} s`;
  }

  if (result.exitCode === 0) {
    return null;
  }

  const stderr = formatCappedText(result.stderr).trim();

  const exit =
    result.exitCode === null
      ? `signal ${result.signal ?? 'unknown'}`
      : `exit ${String(result.exitCode)}`;

  return `${what} (${exit})${stderr === '' ? '' : `: ${stderr}`}`;
}

// null for bytes that are not UTF-8
function encodeContent(bytes: Uint8Array, encoding: 'utf8' | 'base64'): string | null {
  if (encoding === 'base64') {
    return Buffer.from(bytes).toString('base64');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeContent(content: string, encoding: 'utf8' | 'base64'): Uint8Array {
  if (encoding === 'utf8') {
    return new TextEncoder().encode(content);
  }

  const compact = content.replaceAll(/\s/g, '');

  if (compact.length % 4 !== 0 || !BASE64.test(compact)) {
    throw new Error('content is not valid base64');
  }

  return new Uint8Array(Buffer.from(compact, 'base64'));
}
