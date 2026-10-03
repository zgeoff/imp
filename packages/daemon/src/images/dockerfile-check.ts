import { DockerfileError } from './dockerfile-error';
import { parseDockerfile } from './dockerfile-parse';
import type { Instruction } from './dockerfile-parse';

// where a Dockerfile names an image the engine would pull on its own
type ImageUse = 'FROM' | 'COPY --from' | 'RUN --mount from';

export interface ExternalImage {
  readonly ref: string;
  readonly use: ImageUse;
}

// `scheme://` (http, https, git, ssh) or git's `user@host:path`: what ADD
// fetches from the engine's own network (frontend/dockerfile/dfgitutil)
const REMOTE_SOURCE = /:\/\/|^[^\/]*@[^\/]*:/v;

function buildRefusal(line: number, message: string): DockerfileError {
  return new DockerfileError(`line ${String(line)}: ${message}`);
}

// The frontend's shell lexer drops quotes and applies the escape token in
// every FROM, ADD and COPY word and builder flag; refusing both makes the
// word impd checks the word the frontend uses.
function checkPlain(text: string, escape: string, what: string, line: number): void {
  const isAmbiguous =
    text.includes('"') || text.includes("'") || text.includes(escape) || !/^[ -~]*$/v.test(text);

  if (isAmbiguous) {
    throw buildRefusal(
      line,
      `an ambiguous form: ${what} ${JSON.stringify(text)} holds a quote, the escape character or a character that is not printable ASCII`,
    );
  }
}

// The one place FROM --platform is decided. impd sends no platform, so the
// build runs for the host's, which is the platform impd inspects.
function checkPlatform(value: string, line: number): void {
  throw buildRefusal(
    line,
    `FROM --platform=${value} is refused: impd checks a base image for the host's platform only`,
  );
}

// the value of each `--name=value` flag called name
function readFlagValues(instruction: Readonly<Instruction>, name: string): string[] {
  return instruction.flags
    .filter((flag) => flag === `--${name}` || flag.startsWith(`--${name}=`))
    .map((flag) => flag.slice(name.length + 3));
}

// the `from` of each --mount; the frontend reads the mount as CSV, which
// holds no quote here
function readMountFroms(instruction: Readonly<Instruction>): string[] {
  return readFlagValues(instruction, 'mount').flatMap((mount) =>
    mount
      .split(',')
      .map((field) => field.split('='))
      .filter(([key]) => key?.toLowerCase() === 'from')
      .map((parts) => parts.slice(1).join('=')),
  );
}

function checkWords(instruction: Readonly<Instruction>, escape: string): void {
  const keyword = instruction.keyword;
  const line = instruction.line;

  checkPlain(instruction.rawFlags.trim(), escape, `the ${keyword.toUpperCase()} flags`, line);

  if (keyword === 'from') {
    for (const word of instruction.words) {
      checkPlain(word, escape, 'the FROM word', line);

      if (word.includes('$')) {
        throw buildRefusal(
          line,
          `FROM ${word} names its image with a variable, which impd cannot check`,
        );
      }
    }

    for (const platform of readFlagValues(instruction, 'platform')) {
      checkPlatform(platform, line);
    }
  }

  // the sources; the last word is the destination
  if (keyword === 'add') {
    for (const source of instruction.words.slice(0, -1)) {
      checkPlain(source, escape, 'the ADD source', line);

      if (source.includes('$')) {
        throw buildRefusal(
          line,
          `the ADD source ${source} holds a variable, which impd cannot check`,
        );
      }

      if (REMOTE_SOURCE.test(source)) {
        throw buildRefusal(
          line,
          `ADD ${source} is refused: the engine would fetch it from the host's network; fetch it in a RUN step, or send it in the context`,
        );
      }
    }
  }
}

// the lowercased names of every stage; COPY --from and RUN --mount from
// may name any of them, as the frontend reads them
function listStageNames(instructions: readonly Instruction[]): Set<string> {
  const names = new Set<string>();

  for (const instruction of instructions) {
    const [, as, stage] = instruction.words;

    if (instruction.keyword === 'from' && as?.toLowerCase() === 'as' && stage !== undefined) {
      names.add(stage.toLowerCase());
    }
  }

  return names;
}

// Refuses what impd cannot check or would let the engine fetch on its own,
// and returns the images the build names outside its stages, each once.
export function checkDockerfile(dockerfile: string): ExternalImage[] {
  const parsed = parseDockerfile(dockerfile);
  const allStages = listStageNames(parsed.instructions);

  const earlierStages = new Set<string>();

  const images: ExternalImage[] = [];

  const collectImage = (ref: string, use: ImageUse, line: number): void => {
    if (ref.includes('$')) {
      throw buildRefusal(
        line,
        `${use} ${ref} names its image with a variable, which impd cannot check`,
      );
    }

    if (!images.some((image) => image.ref === ref && image.use === use)) {
      images.push({ ref, use });
    }
  };

  for (const instruction of parsed.instructions) {
    const line = instruction.line;

    // a trigger runs in a later build, from this image or a later stage
    if (instruction.keyword === 'onbuild') {
      throw buildRefusal(
        line,
        'ONBUILD is refused: impd checks only the instructions this build runs',
      );
    }

    if (['from', 'add', 'copy', 'run'].includes(instruction.keyword)) {
      checkWords(instruction, parsed.escape);
    }

    if (instruction.keyword === 'from') {
      const [image = '', as, stage] = instruction.words;

      // a base matches an earlier stage as written
      if (image !== '' && image !== 'scratch' && !earlierStages.has(image)) {
        collectImage(image, 'FROM', line);
      }

      if (as?.toLowerCase() === 'as' && stage !== undefined) {
        earlierStages.add(stage.toLowerCase());
      }
    }

    if (instruction.keyword === 'copy') {
      for (const from of readFlagValues(instruction, 'from')) {
        if (!/^\d+$/v.test(from) && from !== 'scratch' && !allStages.has(from.toLowerCase())) {
          collectImage(from, 'COPY --from', line);
        }
      }
    }

    if (instruction.keyword === 'run') {
      for (const from of readMountFroms(instruction)) {
        if (from !== '' && from !== 'scratch' && !allStages.has(from.toLowerCase())) {
          collectImage(from, 'RUN --mount from', line);
        }
      }
    }
  }

  return images;
}
