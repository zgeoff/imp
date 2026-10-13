import { AsyncLocalStorage } from 'node:async_hooks';
import { configureSync } from '@logtape/logtape';
import type { LogRecord } from '@logtape/logtape';

// Sends every impd log line to `write`, one rendered line each (renderLogLine),
// and keeps the context withImpLogContext sets across awaits. Called once at
// the start of a process; a second call replaces the first.
export function setupLogging(write: (line: string) => void = writeStdout): void {
  configureSync({
    reset: true,
    sinks: {
      lines: (record) => {
        write(renderLogLine(record));
      },
    },
    loggers: [
      { category: ['impd'], sinks: ['lines'], lowestLevel: 'debug' },

      // LogTape's own trouble, such as a sink that throws
      { category: ['logtape', 'meta'], sinks: ['lines'], lowestLevel: 'warning' },
    ],
    contextLocalStorage: new AsyncLocalStorage(),
  });
}

// the parts of a LogTape record a line shows
interface RenderedRecord {
  readonly level: LogRecord['level'];
  readonly category: readonly string[];
  readonly message: readonly unknown[];
  readonly properties: Readonly<Record<string, unknown>>;
}

// "<LEVEL> <category> [imp=<name> ]<message>\n": the level, the category
// joined with dots, the imp the line is about, if any, and one line break.
function renderLogLine(record: RenderedRecord): string {
  const imp = record.properties['imp'];
  const about = typeof imp === 'string' ? `imp=${imp} ` : '';

  // escaped, so a stack trace or a multiline value stays on its one line
  const message = record.message
    .map((part) => (typeof part === 'string' ? part : Bun.inspect(part)))
    .join('')
    .replaceAll('\r', String.raw`\r`)
    .replaceAll('\n', String.raw`\n`);

  return `${record.level.toUpperCase()} ${record.category.join('.')} ${about}${message}\n`;
}

// where a rendered line goes: stdout, which the container runtime collects
function writeStdout(line: string): void {
  process.stdout.write(line);
}
