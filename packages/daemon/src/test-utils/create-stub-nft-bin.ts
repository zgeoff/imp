import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface StubNftBinOptions {
  // what it prints to stderr, then the code it exits with; nothing and 0 by
  // default
  readonly stderr?: string;
  readonly exitCode?: number;
}

function formatShellWord(text: string): string {
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

// An executable `nft` in `dir`, for createNftRunner's binary: it records its
// arguments and the script it reads on stdin in files beside it, then prints
// `stderr` and exits with `exitCode`.
export async function createStubNftBin(dir: string, options: Readonly<StubNftBinOptions> = {}) {
  const path = join(dir, 'nft');
  const argvPath = join(dir, 'nft-argv');
  const stdinPath = join(dir, 'nft-stdin');

  await writeFile(
    path,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" > ${formatShellWord(argvPath)}`,
      `cat > ${formatShellWord(stdinPath)}`,
      `printf '%s' ${formatShellWord(options.stderr ?? '')} >&2`,
      `exit ${String(options.exitCode ?? 0)}`,
      '',
    ].join('\n'),
  );

  await chmod(path, 0o755);

  return {
    path,

    // its arguments, space-separated, as the last run got them
    readArgv: (): Promise<string> => readFile(argvPath, 'utf8'),

    // the script the last run read on stdin
    readStdin: (): Promise<string> => readFile(stdinPath, 'utf8'),
  };
}
