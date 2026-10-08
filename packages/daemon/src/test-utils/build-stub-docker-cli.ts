import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIN_INSPECT_FORMAT } from '../images/image-pin';

// what `docker image inspect <ref>` prints one element of
interface StubDockerInspect {
  readonly Id: string;
  readonly RepoDigests?: readonly string[];
  readonly Os?: string;
  readonly Architecture?: string;
  readonly Config?: unknown;
  readonly Size?: number;
}

// how a `docker pull --quiet <ref>` goes: it lands the image, reports
// success but leaves none (as when it is removed before the next call),
// fails with this stderr, or hangs until it is killed or its directory goes
export type StubDockerPull = 'ok' | 'lost' | 'hang' | { readonly stderr: string };

export interface StubDockerImage {
  // every spelling the CLI is called with for this image
  readonly refs: readonly string[];

  // each inspect prints the next of these, then the last again: an image
  // that moves between a pull and the next inspect
  readonly inspects: readonly StubDockerInspect[];

  // on the host before any pull; true by default
  readonly isOnHost?: boolean;
  readonly pull?: StubDockerPull;
}

export interface StubDockerCliOptions {
  // a directory of the test's own; the script goes in its `bin`
  readonly dir: string;

  // what `docker version` prints, `"<os>" "<arch>"`; linux x86_64 by default.
  // `stdout` prints that line as it is, such as `null null` from an engine
  // that reports no server
  readonly version?: { readonly os: string; readonly arch: string } | { readonly stdout: string };
  readonly images?: readonly StubDockerImage[];

  // the container `docker create` makes, or its failure
  readonly create?: { readonly id: string } | { readonly stderr: string };

  // the tar `docker export` prints
  readonly exportTar?: Uint8Array;
}

// the inspect formats impd passes, and how each renders an inspect
const FORMATS: ReadonlyMap<string, (inspect: StubDockerInspect) => string> = new Map([
  ['', (inspect: StubDockerInspect) => JSON.stringify([inspect])],
  ['{{.Id}}', (inspect: StubDockerInspect) => inspect.Id],
  ['{{json .Config}}', (inspect: StubDockerInspect) => JSON.stringify(inspect.Config ?? null)],
  [
    PIN_INSPECT_FORMAT,
    (inspect: StubDockerInspect) =>
      JSON.stringify({
        Id: inspect.Id,
        RepoDigests: inspect.RepoDigests ?? [],
        Os: inspect.Os ?? 'linux',
        Architecture: inspect.Architecture ?? 'amd64',
        Config: inspect.Config ?? null,
      }),
  ],
]);

function formatShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

function buildPullArm(index: number, ref: string, pull: StubDockerPull, state: string): string {
  if (pull === 'hang') {
    // until its kill, or until the test's state directory is gone
    return `  ${formatShellWord(`pull --quiet ${ref}`)}) while [ -d ${formatShellWord(state)} ]; do sleep 0.05; done; exit 1 ;;`;
  }

  if (pull === 'lost') {
    return `  ${formatShellWord(`pull --quiet ${ref}`)}) echo ${formatShellWord(ref)} ;;`;
  }

  if (pull === 'ok') {
    return `  ${formatShellWord(`pull --quiet ${ref}`)}) touch ${formatShellWord(join(state, `pulled-${String(index)}`))}; echo ${formatShellWord(ref)} ;;`;
  }

  return `  ${formatShellWord(`pull --quiet ${ref}`)}) printf '%s\\n' ${formatShellWord(pull.stderr)} >&2; exit 1 ;;`;
}

// One image's inspect arm for one format: the next inspect of its
// sequence, once the image is on the host.
function buildInspectArm(
  index: number,
  image: StubDockerImage,
  argv: string,
  format: string,
  state: string,
): string {
  const tag = String(index);
  const count = formatShellWord(join(state, `inspected-${tag}`));
  const last = String(image.inspects.length - 1);
  const output = formatShellWord(join(state, `inspect-${tag}-`));
  const formatKey = String([...FORMATS.keys()].indexOf(format));

  const present =
    image.isOnHost === false
      ? `[ -e ${formatShellWord(join(state, `pulled-${tag}`))} ] || { echo "Error: No such image: $last" >&2; exit 1; }; `
      : '';

  return [
    `  ${formatShellWord(argv)}) ${present}n=$(cat ${count} 2>/dev/null || echo 0); echo $((n + 1)) >${count}`,
    `    [ "$n" -gt ${last} ] && n=${last}; cat ${output}"$n"-${formatKey} ;;`,
  ].join('\n');
}

// A `docker` CLI in `<dir>/bin` for the host engine: version, inspect in
// each format impd passes, pull, create, export and rm. It logs each argv,
// joined by spaces, and fails any call it does not model.
export function buildStubDockerCli(options: Readonly<StubDockerCliOptions>) {
  const bin = join(options.dir, 'bin');
  const state = join(options.dir, 'stub-docker');
  const log = join(state, 'calls.log');
  const version = options.version ?? { os: 'linux', arch: 'x86_64' };
  const versionLine = 'stdout' in version ? version.stdout : `"${version.os}" "${version.arch}"`;
  const arms: string[] = [];

  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });

  for (const [index, image] of (options.images ?? []).entries()) {
    for (const [sequence, inspect] of image.inspects.entries()) {
      for (const [formatKey, render] of [...FORMATS.values()].entries()) {
        writeFileSync(
          join(state, `inspect-${String(index)}-${String(sequence)}-${String(formatKey)}`),
          `${render(inspect)}\n`,
        );
      }
    }

    for (const ref of image.refs) {
      for (const format of FORMATS.keys()) {
        const argv =
          format === '' ? `image inspect ${ref}` : `image inspect --format ${format} ${ref}`;

        arms.push(buildInspectArm(index, image, argv, format, state));
      }

      arms.push(buildPullArm(index, ref, image.pull ?? 'ok', state));
    }
  }

  const create = options.create;

  if (create !== undefined && 'id' in create) {
    arms.push(`  'create '*) echo ${formatShellWord(create.id)} ;;`);
  }

  if (create !== undefined && 'stderr' in create) {
    arms.push(`  'create '*) printf '%s\\n' ${formatShellWord(create.stderr)} >&2; exit 1 ;;`);
  }

  if (options.exportTar !== undefined) {
    writeFileSync(join(state, 'export.tar'), options.exportTar);

    arms.push(`  'export '*) cat ${formatShellWord(join(state, 'export.tar'))} ;;`);
  }

  const script = [
    '#!/bin/sh',
    `echo "$*" >>${formatShellWord(log)}`,
    'for last; do :; done',
    'case "$*" in',
    `  'version --format '*) echo ${formatShellWord(versionLine)} ;;`,
    ...arms,
    `  'rm -f '*) echo "$last" ;;`,
    `  *) echo "stub docker: $* is not modelled" >&2; exit 1 ;;`,
    'esac',
    '',
  ].join('\n');

  const docker = join(bin, 'docker');

  writeFileSync(docker, script);
  chmodSync(docker, 0o755);

  return {
    bin,

    // PATH with the stub first
    path: `${bin}:${process.env['PATH'] ?? ''}`,

    // each call's argv, joined by spaces, in order
    readCalls: (): string[] =>
      existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : [],
  };
}
