import { DockerfileError } from './dockerfile-error';
import { parseDockerfile } from './dockerfile-parse';
import type { Instruction } from './dockerfile-parse';

// The frontend's shell lexer drops quotes and applies the escape token in
// every FROM, ADD and COPY word and builder flag; refusing both makes the
// word impd checks the word the frontend uses.
function checkPlain(text: string, escape: string, what: string, line: number): void {
  const isAmbiguous =
    text.includes('"') ||
    text.includes("'") ||
    text.includes(escape) ||
    !/^[\u0020-\u007E]*$/v.test(text);

  if (isAmbiguous) {
    throw new DockerfileError(
      `line ${String(line)}: an ambiguous form: ${what} ${JSON.stringify(text)} holds a quote, the escape character or a character that is not printable ASCII`,
    );
  }
}

function checkInstruction(instruction: Readonly<Instruction>, escape: string): void {
  const keyword = instruction.keyword;
  const line = instruction.line;

  if (instruction.trigger !== null) {
    checkInstruction(instruction.trigger, escape);
  }

  if (!['from', 'add', 'copy', 'run'].includes(keyword)) {
    return;
  }

  checkPlain(instruction.rawFlags.trim(), escape, `the ${keyword.toUpperCase()} flags`, line);

  if (keyword === 'from') {
    for (const word of instruction.words) {
      checkPlain(word, escape, 'the FROM word', line);
    }
  }

  // the sources; the last word is the destination
  if (keyword === 'add') {
    for (const source of instruction.words.slice(0, -1)) {
      checkPlain(source, escape, 'the ADD source', line);
    }
  }
}

// The images a Dockerfile's FROM lines name outright, each once: not
// scratch, not an earlier stage, and not one built from an ARG. Refuses a
// form impd could read another way than the frontend does.
export function listBaseImages(dockerfile: string): string[] {
  const parsed = parseDockerfile(dockerfile);

  const stages = new Set<string>();

  const images: string[] = [];

  for (const instruction of parsed.instructions) {
    checkInstruction(instruction, parsed.escape);

    if (instruction.keyword !== 'from') {
      continue;
    }

    const [image = '', as, stage] = instruction.words;

    // the frontend matches a base to an earlier stage as written, against
    // stage names it lowercased
    if (
      image !== '' &&
      image !== 'scratch' &&
      !image.includes('$') &&
      !stages.has(image) &&
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
