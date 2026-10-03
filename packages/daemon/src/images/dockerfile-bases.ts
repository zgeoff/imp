// `<<EOF`, `<<-EOF`, `<<"EOF"`: a heredoc and its terminating word
const HEREDOC = /<<(?<strip>-?)(?<quote>["']?)(?<word>[A-Za-z_][A-Za-z0-9_]*)\k<quote>/gv;
const ESCAPE_DIRECTIVE = /^#\s*escape\s*=\s*(?<escape>[\\`])\s*$/iv;

interface Heredoc {
  readonly word: string;
  readonly isStripped: boolean;
}

// The parser directive that changes the line-continuation character; only
// the comment lines at the very top can hold it.
function readEscape(lines: readonly string[]): string {
  for (const line of lines) {
    if (!line.startsWith('#')) {
      break;
    }

    const escape = ESCAPE_DIRECTIVE.exec(line)?.groups?.['escape'];

    if (escape !== undefined) {
      return escape;
    }
  }

  return '\\';
}

// The Dockerfile's instructions, one string each: continuations joined,
// comments and heredoc bodies left out.
function readInstructions(dockerfile: string): string[] {
  const lines = dockerfile.split(/\r?\n/v);
  const escape = readEscape(lines);
  const instructions: string[] = [];
  const heredocs: Heredoc[] = [];
  let current = '';

  for (const line of lines) {
    const [heredoc] = heredocs;

    if (heredoc !== undefined) {
      const end = heredoc.isStripped ? line.replace(/^\t+/v, '') : line;

      if (end === heredoc.word) {
        heredocs.shift();
      }

      continue;
    }

    const trimmed = line.trim();

    // an empty line inside a continuation does not end it
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    if (trimmed.endsWith(escape)) {
      current += `${trimmed.slice(0, -1)} `;
      continue;
    }

    const instruction = `${current}${trimmed}`;

    current = '';

    instructions.push(instruction);

    for (const match of instruction.matchAll(HEREDOC)) {
      heredocs.push({
        word: match.groups?.['word'] ?? '',
        isStripped: match.groups?.['strip'] === '-',
      });
    }
  }

  return instructions;
}

// The images a Dockerfile's FROM lines name outright, each once: not
// scratch, not an earlier stage, and not one built from an ARG, which
// only the build can resolve.
export function listBaseImages(dockerfile: string): string[] {
  const stages = new Set<string>();

  const images: string[] = [];

  for (const instruction of readInstructions(dockerfile)) {
    const [keyword = '', ...args] = instruction.split(/\s+/v);

    if (keyword.toLowerCase() !== 'from') {
      continue;
    }

    const [image = '', as, stage] = args.filter((arg) => !arg.startsWith('--'));
    const name = image.toLowerCase();

    if (
      image !== '' &&
      name !== 'scratch' &&
      !image.includes('$') &&
      !stages.has(name) &&
      !images.includes(image)
    ) {
      images.push(image);
    }

    if (as?.toLowerCase() === 'as' && stage !== undefined) {
      stages.add(stage.toLowerCase());
    }
  }

  return images;
}
