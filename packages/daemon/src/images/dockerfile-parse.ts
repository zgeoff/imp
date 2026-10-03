// A Dockerfile split into instructions as the pinned frontend's parser splits
// it (moby/buildkit v0.25.0, frontend/dockerfile/parser): each rule mirrors
// the frontend's, down to which bytes count as whitespace.

import { DockerfileError } from './dockerfile-error';

export interface Instruction {
  // the keyword, lowercased, and as written; only ASCII keywords are read
  readonly keyword: string;
  readonly command: string;

  // the builder flags, such as `--from=build`, and the text they came from
  readonly flags: readonly string[];
  readonly rawFlags: string;

  // what follows the flags, trimmed
  readonly args: string;

  // the arguments: the JSON array's strings, or args split at whitespace
  readonly words: readonly string[];
  readonly isJson: boolean;

  // ONBUILD's own instruction
  readonly trigger: Instruction | null;

  // the 1-based lines the instruction starts and ends on, before any
  // heredoc's body
  readonly line: number;
  readonly endLine: number;
}

export interface ParsedDockerfile {
  readonly escape: string;
  readonly instructions: readonly Instruction[];
}

// Go's unicode.IsSpace, which trims lines and splits commands
const GO_SPACE = String.raw`\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000`;

const LEADING_SPACE = new RegExp(`^[${GO_SPACE}]+`, 'v');
const TRAILING_SPACE = new RegExp(`[${GO_SPACE}]+$`, 'v');

// the parser's reWhitespace, which splits FROM, ADD and COPY arguments
const WORD_SPACE = /[\t\v\f\r ]+/v;

// Go's \s in the directive pattern: no \v
const DIRECTIVE =
  /^#[\t\n\f\r ]*(?<key>[a-zA-Z][a-zA-Z0-9]*)[\t\n\f\r ]*=[\t\n\f\r ]*(?<value>.+?)[\t\n\f\r ]*$/v;

const DIRECTIVE_KEYS = new Set(['syntax', 'escape', 'check']);

const HEREDOC_WORD = /^(?<fd>\d*)<<(?<strip>-?)[\t\n\f\r ]*(?<rest>[^<]*)$/v;

const HEREDOC_KEYWORDS = new Set(['add', 'copy', 'run']);
const JSON_KEYWORDS = new Set(['add', 'copy', 'volume']);
const WORD_KEYWORDS = new Set(['from', 'expose']);

// the bytes extractBuilderFlags reads as spaces: it tests each byte, not
// each character, with unicode.IsSpace
const FLAG_SPACE_BYTES = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0]);

function removeGoSpace(text: string): string {
  return text.replace(LEADING_SPACE, '').replace(TRAILING_SPACE, '');
}

function removeNewline(line: string): string {
  return line.replace(/[\r\n]+$/v, '');
}

function isComment(line: string): boolean {
  return line.replace(LEADING_SPACE, '').startsWith('#');
}

// the lines with their endings, as the parser's scanLines gives them,
// after the byte order mark it drops
export function splitDockerfileLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/v, '').match(/[^\n]*\n|[^\n]+$/gv) ?? [];

  return lines;
}

function buildContinuation(escape: string): RegExp {
  const token = escape === '`' ? '`' : String.raw`\\`;

  return new RegExp(`([^${token}])${token}[ \\t]*$|^${token}[ \\t]*$`, 'v');
}

// The parser directives, which come first: the first line that is not one
// ends them. Holds the escape token they set.
class DirectiveReader {
  escape = '\\';

  private continuation = buildContinuation('\\');

  private isDone = false;

  private readonly seen = new Set<string>();

  readLine(line: string): void {
    if (this.isDone) {
      return;
    }

    const match = DIRECTIVE.exec(line);
    const key = match?.groups?.['key']?.toLowerCase();

    if (key === undefined || !DIRECTIVE_KEYS.has(key)) {
      this.isDone = true;

      return;
    }

    if (this.seen.has(key)) {
      throw new DockerfileError(`the Dockerfile has more than one ${key} parser directive`);
    }

    this.seen.add(key);

    const value = match?.groups?.['value'] ?? '';

    if (key === 'escape') {
      if (value !== '\\' && value !== '`') {
        throw new DockerfileError(
          `the escape parser directive ${JSON.stringify(value)} is not \\ or \``,
        );
      }

      this.escape = value;
      this.continuation = buildContinuation(value);
    }
  }

  // the line with a trailing escape token removed, and whether it ends there
  splitContinuation(line: string): [string, boolean] {
    if (this.continuation.test(line)) {
      return [line.replace(this.continuation, '$1'), false];
    }

    return [line, true];
  }
}

interface SplitFlags {
  readonly flags: string[];

  // the flags as written, before quotes and escapes are applied
  readonly raw: string;
  readonly args: string;
}

// extractBuilderFlags, byte for byte: the leading `--` words, with quotes and
// the escape token applied, and the rest of the line
function splitFlags(rest: string, escape: string): SplitFlags {
  const bytes = new TextEncoder().encode(rest);

  const escapeByte = escape.codePointAt(0);

  const decoder = new TextDecoder();

  const flags: string[] = [];
  let word: number[] = [];
  let phase: 'spaces' | 'word' | 'quote' = 'spaces';
  let quote = 0;
  let isBlankOk = false;
  let position = 0;

  const splitAt = (at: number): SplitFlags => ({
    flags,
    raw: decoder.decode(bytes.subarray(0, at)),
    args: decoder.decode(bytes.subarray(at)),
  });

  for (; position <= bytes.length; position += 1) {
    const byte = bytes[position] ?? 0;

    if (phase === 'spaces') {
      if (position === bytes.length) {
        break;
      }

      if (FLAG_SPACE_BYTES.has(byte)) {
        continue;
      }

      if (byte !== 0x2d || bytes[position + 1] !== 0x2d) {
        return splitAt(position);
      }

      phase = 'word';
    }

    if (position === bytes.length) {
      const text = decoder.decode(new Uint8Array(word));

      if (text !== '--' && (isBlankOk || text.length > 0)) {
        flags.push(text);
      }

      break;
    }

    if (phase === 'word') {
      if (FLAG_SPACE_BYTES.has(byte)) {
        const text = decoder.decode(new Uint8Array(word));

        phase = 'spaces';

        if (text === '--') {
          return splitAt(position);
        }

        if (isBlankOk || text.length > 0) {
          flags.push(text);
        }

        word = [];
        isBlankOk = false;
        continue;
      }

      if (byte === 0x27 || byte === 0x22) {
        quote = byte;
        isBlankOk = true;
        phase = 'quote';
        continue;
      }
    } else if (byte === quote) {
      phase = 'word';
      continue;
    }

    if (byte === escapeByte) {
      if (position + 1 === bytes.length) {
        if (phase === 'quote') {
          phase = 'word';
        }

        continue;
      }

      position += 1;
    }

    word.push(bytes[position] ?? 0);
  }

  return splitAt(bytes.length);
}

// parseJSON: a JSON array of strings, or null when the text is not one
function readJsonWords(args: string): string[] | null {
  const text = args.replace(LEADING_SPACE, '');

  if (!text.startsWith('[')) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  return parsed.map((item: unknown) => {
    if (typeof item !== 'string') {
      throw new DockerfileError(`the JSON array ${text} holds a value that is not a string`);
    }

    return item;
  });
}

function readWords(keyword: string, args: string): { words: string[]; isJson: boolean } {
  if (args === '') {
    return { words: [], isJson: false };
  }

  const json = JSON_KEYWORDS.has(keyword) || keyword === 'run' ? readJsonWords(args) : null;

  if (json !== null) {
    return { words: json, isJson: true };
  }

  if (JSON_KEYWORDS.has(keyword) || WORD_KEYWORDS.has(keyword)) {
    return { words: args.split(WORD_SPACE), isJson: false };
  }

  return { words: [args], isJson: false };
}

// newNodeFromLine: the keyword, its flags and its arguments
function readInstruction(text: string, escape: string, line: number, endLine: number): Instruction {
  const trimmed = removeGoSpace(text);
  const commandEnd = WORD_SPACE.exec(trimmed);
  const command = commandEnd === null ? trimmed : trimmed.slice(0, commandEnd.index);
  const rest = commandEnd === null ? '' : trimmed.slice(commandEnd.index + commandEnd[0].length);

  if (command === '') {
    throw new DockerfileError(`line ${String(line)}: an instruction has no name`);
  }

  // Go lowercases a few non-ASCII letters to ASCII ones, which would make
  // a keyword impd does not see
  if (!/^[\u0021-\u007E]+$/v.test(command)) {
    throw new DockerfileError(
      `line ${String(line)}: the instruction ${JSON.stringify(command)} is not ASCII`,
    );
  }

  const keyword = command.toLowerCase();
  const split = splitFlags(rest, escape);
  const args = removeGoSpace(split.args);

  const trigger =
    keyword === 'onbuild' && args !== '' ? readInstruction(args, escape, line, endLine) : null;

  const read = keyword === 'onbuild' ? { words: [], isJson: false } : readWords(keyword, args);

  return {
    keyword,
    command,
    flags: split.flags,
    rawFlags: split.raw,
    args,
    words: read.words,
    isJson: read.isJson,
    trigger,
    line,
    endLine,
  };
}

function canHoldHeredoc(instruction: Readonly<Instruction>): boolean {
  const target = instruction.keyword === 'onbuild' ? instruction.trigger : instruction;

  return target !== null && HEREDOC_KEYWORDS.has(target.keyword) && !target.isJson;
}

// One step of the frontend's shell lexer over a heredoc line, enough to
// find the words: quotes and escapes kept as written, `<<` and the spaces
// after it kept in the word.
function splitShellWords(text: string, escape: string, keepQuotes: boolean): string[] | null {
  const words: string[] = [];
  let word = '';
  let isInWord = false;
  let index = 0;

  const collectWord = (): void => {
    if (word.length > 0) {
      words.push(word);

      word = '';
    }

    isInWord = false;
  };

  while (index < text.length) {
    const char = text.charAt(index);

    if (char === "'" || char === '"') {
      const end = findQuoteEnd(text, index, escape);

      if (end === -1) {
        return null;
      }

      const quoted = text.slice(index, end + 1);

      word += keepQuotes ? quoted : removeQuotes(quoted);
      isInWord = true;
      index = end + 1;
      continue;
    }

    if (char === '<' && text.charAt(index + 1) === '<') {
      const spaces = /^[\t\r ]*/v.exec(text.slice(index + 2))?.[0] ?? '';

      word += `<<${spaces}`;
      isInWord = true;
      index += 2 + spaces.length;
      continue;
    }

    if (char === escape) {
      if (keepQuotes) {
        word += char;
      }

      if (index + 1 < text.length) {
        word += text.charAt(index + 1);
      }

      isInWord = true;
      index += 2;
      continue;
    }

    if (LEADING_SPACE.test(char)) {
      if (isInWord) {
        collectWord();
      }
    } else {
      word += char;
      isInWord = true;
    }

    index += 1;
  }

  collectWord();

  return words;
}

// the index of the quote that closes the one at start, or -1
function findQuoteEnd(text: string, start: number, escape: string): number {
  const quote = text.charAt(start);

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text.charAt(index);

    if (char === quote) {
      return index;
    }

    if (quote === '"' && char === escape) {
      index += 1;
    }
  }

  return -1;
}

// the heredoc lexer's own escape token is always a backslash
function removeQuotes(quoted: string): string {
  const inner = quoted.slice(1, -1);

  return quoted.startsWith("'") ? inner : inner.replaceAll(/\\(?<char>["$\\])/gv, '$<char>');
}

interface Heredoc {
  readonly name: string;
  readonly isStripped: boolean;
}

// heredocsFromLine: the heredocs the instruction opens, in order
function findHeredocs(text: string, line: number): Heredoc[] {
  // a ${...} expansion can hold spaces, which would move the word breaks
  if (text.includes('${')) {
    throw new DockerfileError(
      `line ${String(line)}: an ambiguous form: \${...} on a line that holds <<`,
    );
  }

  const heredocs: Heredoc[] = [];

  for (const word of splitShellWords(text, '\\', true) ?? []) {
    const match = HEREDOC_WORD.exec(word);
    const rest = match?.groups?.['rest'] ?? '';

    if (match === null || rest === '') {
      continue;
    }

    const names = splitShellWords(rest, '\\', false);

    if (names === null) {
      throw new DockerfileError(`line ${String(line)}: the heredoc word ${rest} is not closed`);
    }

    if (names.length === 1) {
      heredocs.push({ name: names[0] ?? '', isStripped: match.groups?.['strip'] === '-' });
    }
  }

  return heredocs;
}

// Splits the Dockerfile as the frontend's parser.Parse does.
export function parseDockerfile(text: string): ParsedDockerfile {
  const lines = splitDockerfileLines(text);

  const directives = new DirectiveReader();

  const instructions: Instruction[] = [];
  let index = 0;

  // the parser's processLine: the line without its ending, and without a comment
  const readLine = (raw: string, isFirst: boolean): string => {
    const trimmed = isFirst ? removeNewline(raw).replace(LEADING_SPACE, '') : removeNewline(raw);

    directives.readLine(trimmed);

    return isComment(trimmed) ? '' : trimmed;
  };

  while (index < lines.length) {
    const startLine = index + 1;
    const first = readLine(lines[index] ?? '', true);

    index += 1;

    let [joined, isEnd] = directives.splitContinuation(first);

    if (isEnd && joined.length === 0) {
      continue;
    }

    while (!isEnd && index < lines.length) {
      const raw = lines[index] ?? '';
      const next = readLine(raw, false);

      index += 1;

      if (isComment(raw) || next.replace(LEADING_SPACE, '').length === 0) {
        continue;
      }

      const [part, ended] = directives.splitContinuation(next);

      joined += part;
      isEnd = ended;
    }

    const instruction = readInstruction(joined, directives.escape, startLine, index);

    if (canHoldHeredoc(instruction) && joined.includes('<<')) {
      for (const heredoc of findHeredocs(joined, startLine)) {
        let isTerminated = false;

        while (index < lines.length && !isTerminated) {
          const body = removeNewline(lines[index] ?? '');
          const candidate = heredoc.isStripped ? body.replace(/^\t+/v, '') : body;

          index += 1;
          isTerminated = candidate === heredoc.name;
        }

        if (!isTerminated) {
          throw new DockerfileError(
            `line ${String(startLine)}: the heredoc ${heredoc.name} is not closed`,
          );
        }
      }
    }

    instructions.push(instruction);
  }

  if (instructions.length === 0) {
    throw new DockerfileError('the Dockerfile has no instructions');
  }

  return { escape: directives.escape, instructions };
}
