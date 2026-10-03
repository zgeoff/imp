#!/usr/bin/env bun
// Parses generated Dockerfiles with impd's port (dockerfile-parse.ts) and
// with the Go parser it ports, and fails on any file the two read
// differently. See README.md.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import * as z from 'zod';
import { parseDockerfile } from '../../packages/daemon/src/images/dockerfile-parse';
import type { Instruction } from '../../packages/daemon/src/images/dockerfile-parse';

const GoInstructionSchema = z.object({
  keyword: z.string(),
  flags: z.array(z.string()),
  words: z.array(z.string()),
  trigger: z.string().optional(),
});

const GoResultSchema = z.object({
  error: z.string().optional(),
  escape: z.string().optional(),
  instructions: z.array(GoInstructionSchema).optional(),
});

type GoInstruction = z.infer<typeof GoInstructionSchema>;

type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? readonly U[] : T[K];
};

type GoResult = z.infer<typeof GoResultSchema>;

interface Comparable {
  readonly keyword: string;
  readonly flags: readonly string[];
  readonly words: readonly string[] | null;
  readonly trigger: string | null;
}

// Errors from parsers impd does not port (ENV and LABEL pairs): Go fails
// the build on them, so impd accepting the file lets nothing through.
const HARMLESS_GO_ERRORS = [/^Syntax error - can't find = in /v];

// Lines with the forms the frontend could read another way than a naive
// reader: quotes and escapes, the escape directive, continuations,
// heredocs, JSON arrays with escapes, and space that is not ASCII.
const PIECES = [
  'FROM a:1',
  'from c',
  'FROM --platform=x b:2 AS s',
  'FROM h:1 AS \\',
  'FROM d \\',
  '  e:1',
  'FROM f `',
  'FROM `',
  'FROM\u00A0g',
  'FROM j\u000Bk',
  'FROM l\u000Cm',
  'ADD h"ttp:"//x /p',
  "ADD h'ttp://'x /p",
  String.raw`ADD h\ttp://x /p`,
  'ADD x`y z',
  'ADD  a\tb  c',
  'ADD\tn\to',
  'ADD ["http://x", "/p"]',
  String.raw`ADD ["\u0068ttp://x", "/p"]`,
  String.raw`ADD ["h\"ttp://x", "/p"]`,
  String.raw`ADD ["a\\b", "\/p"]`,
  'ADD [ "x" , "y" ]',
  'ADD ["x" "y"]',
  'ADD ["a",',
  'ADD --chown="a b" x y',
  String.raw`ADD --chown=a\ b x y`,
  'ADD <<A <<B /d',
  'COPY --from=s /a /b',
  'COPY --from="q r" /a /b',
  'COPY --from=x`y a b',
  'COPY --from=a\u00A0--chown=1 x y',
  'COPY --link --from=s a b',
  'COPY ["a b", "c"]',
  'COPY <<EOF /x',
  'COPY <<EOF <<-EOF2 /d',
  'RUN --mount=type=bind,from=x true',
  'RUN --mount=type=cache,from=c,target=/x true',
  'RUN --x="a b" c',
  'RUN -- --x',
  'RUN cat <<EOF',
  'RUN cat << EOF >x',
  'RUN cat <<-"END"',
  'RUN <<EOF cat; cat <<-E2',
  'RUN <<"E"O\'F\'',
  String.raw`RUN <<E\OF`,
  "RUN <<'E O'",
  'RUN 2<<EOF',
  'RUN 3<<-X',
  'RUN a<<EOF',
  'RUN "<<EOF"',
  "RUN echo '<<EOF'",
  'RUN echo "<<EOF',
  'RUN echo $HOME <<EOF',
  'RUN ["sh","<<EOF"]',
  'RUN <<EOF\\',
  'RUN cat <<EOF \\',
  '  && cat <<F2',
  String.raw`RUN x \\`,
  String.raw`RUN y \ `,
  'RUN echo `',
  'RUN \\',
  'Run <<EOF',
  'run ["a"]',
  'LABEL a=<<EOF',
  'ENV A=1 \\',
  'ONBUILD',
  'ONBUILD RUN <<EOF',
  'ONBUILD ADD x y',
  'ONBUILD COPY <<EOF /x',
  'expose 80 81',
  'EOF',
  'EOF ',
  'END',
  '\tEND',
  'E2',
  '\tE2',
  'F2',
  'X',
  '\tX',
  'A',
  'B',
  '\tEOF2',
  '\\',
  '',
  '   ',
  '# comment',
  '  # inner comment',
  '# escape=`',
  '# escape=\\',
  '#escape = `',
  '# syntax=x',
  '#check=skip=all',
];

// a fixed-seed generator, so a failing file can be made again; it returns
// the high bits of a 31-bit LCG, whose low bits repeat too soon
function makeRandom(seed: number): () => number {
  const state = { value: seed % 2_147_483_648 };

  return () => {
    state.value = (state.value * 1_103_515_245 + 12_345) % 2_147_483_648;

    return Math.floor(state.value / 65_536);
  };
}

function buildDockerfile(random: () => number): string {
  const count = 1 + (random() % 9);
  const lines = Array.from({ length: count }, () => PIECES[random() % PIECES.length] ?? '');
  const ending = random() % 5 === 0 ? '\r\n' : '\n';
  const bom = random() % 7 === 0 ? '\uFEFF' : '';

  return `${bom}${lines.join(ending)}${random() % 2 === 0 ? ending : ''}`;
}

// non-ASCII flags differ only in how each side decodes the bytes; impd
// refuses them before it reads them
function normalizeFlag(flag: string): string {
  const isAscii = new TextEncoder().encode(flag).every((byte) => byte < 128);

  return isAscii ? flag : 'non-ascii';
}

const WORD_KEYWORDS = new Set(['from', 'add', 'copy']);

function toComparable(instruction: Readonly<Instruction>): Comparable {
  return {
    keyword: instruction.keyword,
    flags: instruction.flags.map((flag) => normalizeFlag(flag)),
    words: WORD_KEYWORDS.has(instruction.keyword) ? instruction.words : null,
    trigger: instruction.trigger?.keyword ?? null,
  };
}

function toGoComparable(instruction: DeepReadonly<GoInstruction>): Comparable {
  return {
    keyword: instruction.keyword,
    flags: instruction.flags.map((flag) => normalizeFlag(flag)),
    words: WORD_KEYWORDS.has(instruction.keyword) ? instruction.words : null,
    trigger: instruction.trigger ?? null,
  };
}

function readOurs(dockerfile: string) {
  try {
    const parsed = parseDockerfile(dockerfile);

    return {
      error: null,
      escape: parsed.escape,
      instructions: parsed.instructions.map((instruction) => toComparable(instruction)),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      escape: '',
      instructions: [],
    };
  }
}

// the error's class: its text without line numbers and quoted parts
function formatErrorClass(error: string): string {
  return error.replaceAll(/line \d+/gv, 'line N').replaceAll(/"[^"]*"/gv, '"…"');
}

function runGo(binary: string, dockerfiles: readonly string[]): GoResult[] {
  const child = Bun.spawnSync([binary], { stdin: Buffer.from(JSON.stringify(dockerfiles)) });

  if (child.exitCode !== 0) {
    throw new Error(
      `dockerfile-difftest exited ${String(child.exitCode)}: ${child.stderr.toString()}`,
    );
  }

  return child.stdout
    .toString()
    .trim()
    .split('\n')
    .map((line) => GoResultSchema.parse(JSON.parse(line)));
}

function buildGo(): string {
  const dir = import.meta.dir;
  const outDir = join(dir, '..', '..', '.cache', 'dockerfile-difftest');
  const binary = join(outDir, 'dockerfile-difftest');

  mkdirSync(outDir, { recursive: true });

  const built = Bun.spawnSync(['go', 'build', '-o', binary, '.'], { cwd: dir, stderr: 'inherit' });

  if (built.exitCode !== 0) {
    throw new Error('go build failed');
  }

  return binary;
}

function main(): number {
  const args = parseArgs({
    options: {
      seed: { type: 'string', default: '1' },
      count: { type: 'string', default: '60000' },
    },
  });

  const values = args.values;
  const random = makeRandom(Number(values.seed));
  const dockerfiles = Array.from({ length: Number(values.count) }, () => buildDockerfile(random));
  const theirs = runGo(buildGo(), dockerfiles);

  const counts = {
    both: 0,
    bothRefuse: 0,
    mismatches: 0,
    oursOnlyRefuse: 0,
    goOnlyRefuse: 0,
    unexplained: 0,
  };

  const oursOnly = new Map<string, number>();
  const goOnly = new Map<string, number>();

  dockerfiles.forEach((dockerfile, index) => {
    const ours = readOurs(dockerfile);
    const go = theirs[index] ?? { error: 'no result' };

    if (ours.error !== null && go.error !== undefined) {
      counts.bothRefuse += 1;

      return;
    }

    if (ours.error !== null) {
      counts.oursOnlyRefuse += 1;

      oursOnly.set(
        formatErrorClass(ours.error),
        (oursOnly.get(formatErrorClass(ours.error)) ?? 0) + 1,
      );

      return;
    }

    if (go.error !== undefined) {
      counts.goOnlyRefuse += 1;

      goOnly.set(formatErrorClass(go.error), (goOnly.get(formatErrorClass(go.error)) ?? 0) + 1);

      if (!HARMLESS_GO_ERRORS.some((pattern) => pattern.test(go.error ?? ''))) {
        counts.unexplained += 1;

        console.log(`go refuses, impd accepts: ${JSON.stringify(dockerfile)}\n  ${go.error}`);
      }

      return;
    }

    counts.both += 1;

    const goView = JSON.stringify({
      escape: go.escape,
      instructions: (go.instructions ?? []).map((instruction) => toGoComparable(instruction)),
    });

    const ourView = JSON.stringify({ escape: ours.escape, instructions: ours.instructions });

    if (goView !== ourView) {
      counts.mismatches += 1;

      console.log(`differs: ${JSON.stringify(dockerfile)}\n  impd ${ourView}\n  go   ${goView}`);
    }
  });

  console.log(JSON.stringify({ seed: values.seed, files: dockerfiles.length, ...counts }, null, 2));
  console.log('impd refuses, go accepts:', Object.fromEntries(oursOnly));
  console.log('go refuses, impd accepts:', Object.fromEntries(goOnly));

  return counts.mismatches + counts.unexplained === 0 ? 0 : 1;
}

process.exit(main());
