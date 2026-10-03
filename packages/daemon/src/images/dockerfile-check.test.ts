import { expect, test } from 'bun:test';
import { checkDockerfile, renderPinnedDockerfile } from './dockerfile-check';
import { DockerfileError } from './dockerfile-error';

function listBaseImages(dockerfile: string): string[] {
  return checkDockerfile(dockerfile)
    .filter((image) => image.use === 'FROM')
    .map((image) => image.ref);
}

test('it lists each FROM image once, past stage names', () => {
  const dockerfile = [
    '# syntax=docker/dockerfile:1',
    'FROM golang:1.26 AS build',
    'RUN go build',
    'from ghcr.io/acme/base:2 as Runtime',
    'COPY --from=build /out /out',
    'FROM golang:1.26',
  ].join('\n');

  expect(listBaseImages(dockerfile)).toEqual(['golang:1.26', 'ghcr.io/acme/base:2']);
});

// the frontend matches a base to a stage as written: `FROM TOOLS` is an
// image, which then fails as a reference
test('it leaves out scratch and earlier stages', () => {
  const dockerfile = [
    'FROM scratch AS empty',
    'FROM busybox:1.37 AS Tools',
    'FROM tools',
    'FROM TOOLS',
    'FROM empty',
  ].join('\n');

  expect(listBaseImages(dockerfile)).toEqual(['busybox:1.37', 'TOOLS']);
});

test('it joins continuations, skips comments in them, and honors # escape=', () => {
  const backslash = 'FROM \\\n  # a comment\n\n  alpine:3.20 \\\n  AS a\nFROM a\n';
  const backtick = '# escape=`\nFROM `\n  alpine:3.21\nRUN dir C:\\\nFROM debian:13\n';

  expect(listBaseImages(backslash)).toEqual(['alpine:3.20']);
  expect(listBaseImages(backtick)).toEqual(['alpine:3.21', 'debian:13']);
});

test('a FROM line inside a heredoc is not an instruction', () => {
  const dockerfile = [
    'FROM alpine:3.20',
    'RUN <<EOF cat >/a && cat <<-"END" >/b',
    'FROM evil/inside:1',
    'EOF',
    '\tFROM evil/second:1',
    '\tEND',
    'COPY <<NOTE /note',
    'FROM evil/third:1',
    'NOTE',
    'FROM busybox:1.37',
  ].join('\n');

  expect(listBaseImages(dockerfile)).toEqual(['alpine:3.20', 'busybox:1.37']);
});

test('a << inside a quoted string does not start a heredoc', () => {
  const dockerfile = [
    'FROM alpine:3.20',
    `RUN echo "<<EOF" && echo 'a <<-END b' && echo "say \\"<<NOTE\\""`,
    'FROM busybox:1.37',
    'RUN cat <<"EOF" >/a',
    'FROM evil/inside:1',
    'EOF',
    'FROM debian:13',
  ].join('\n');

  expect(listBaseImages(dockerfile)).toEqual(['alpine:3.20', 'busybox:1.37', 'debian:13']);
});

function readRefusal(dockerfile: string): string {
  try {
    listBaseImages(dockerfile);
  } catch (error) {
    expect(error).toBeInstanceOf(DockerfileError);

    return error instanceof Error ? error.message : '';
  }

  throw new Error('the Dockerfile was not refused');
}

test('a quote or the escape character in an ADD source is an ambiguous form', () => {
  const refusals = [
    'FROM a:1\nADD h"ttp:"//example.invalid/probe /probe',
    "FROM a:1\nADD h'ttp://'example.invalid/probe /probe",
    'FROM a:1\nADD h\\ttp://example.invalid/probe /probe',
    'FROM a:1\nADD ["h\\"ttp:\\"//example.invalid/probe", "/probe"]',
    '# escape=`\nFROM a:1\nADD h`ttp://example.invalid/probe /probe',
  ].map((dockerfile) => readRefusal(dockerfile));

  for (const refusal of refusals) {
    expect(refusal).toContain('an ambiguous form: the ADD source');
  }

  // with the default escape, a backtick is the source's own character
  expect(listBaseImages('FROM a:1\nADD h`ttp /probe')).toEqual(['a:1']);
});

test('a quote or the escape character in builder flags or FROM words is an ambiguous form', () => {
  const refusals = [
    'FROM a:1\nCOPY --from="evil/x:1" /a /b',
    "FROM a:1\nRUN --mount=type=bind,from='evil/x:1' true",
    String.raw`FROM --platform=linux\/amd64 a:1`,
    'FROM "evil/x:1"',
    'FROM a:1\nCOPY --from=\u0435vil /a /b',
  ].map((dockerfile) => readRefusal(dockerfile));

  expect(refusals.map((refusal) => refusal.split(': ')[1])).toEqual([
    'an ambiguous form',
    'an ambiguous form',
    'an ambiguous form',
    'an ambiguous form',
    'an ambiguous form',
  ]);
});

test('parser directives end at the first other line, and may not repeat', () => {
  const afterComment = '# hello\n# escape=`\nFROM a:1 `\nFROM b:1\n';
  const afterBom = '\uFEFF# escape=`\nFROM `\n  c:1\n';

  // the escape directive does not hold after the comment: the backtick is
  // no continuation, and FROM a:1 ` is a FROM of three words
  expect(listBaseImages(afterComment)).toEqual(['a:1', 'b:1']);
  expect(listBaseImages(afterBom)).toEqual(['c:1']);

  expect(readRefusal('# escape=`\n# escape=\\\nFROM a:1')).toContain(
    'more than one escape parser directive',
  );
});

test('a line ending in an escaped escape character does not continue', () => {
  const dockerfile = 'FROM a:1\nRUN echo \\\\\nFROM b:1\n';

  expect(listBaseImages(dockerfile)).toEqual(['a:1', 'b:1']);
});

test('only shell-form RUN, COPY and ADD open heredocs, as the frontend reads them', () => {
  const label = 'FROM a:1\nLABEL note=<<EOF\nFROM evil/label:1\n';
  const json = 'FROM a:1\nRUN ["sh", "-c", "cat <<EOF"]\nFROM evil/json:1\n';
  const spaced = 'FROM a:1\nRUN cat << EOF\nFROM evil/spaced:1\nEOF\nFROM b:1\n';
  const unclosedQuote = 'FROM a:1\nRUN echo "<<EOF\nFROM evil/quote:1\n';

  expect(listBaseImages(label)).toEqual(['a:1', 'evil/label:1']);
  expect(listBaseImages(json)).toEqual(['a:1', 'evil/json:1']);
  expect(listBaseImages(spaced)).toEqual(['a:1', 'b:1']);
  expect(listBaseImages(unclosedQuote)).toEqual(['a:1', 'evil/quote:1']);
  expect(readRefusal(`FROM a:1\nRUN cat <<EOF \${X:-a b}\nEOF\n`)).toContain('an ambiguous form');

  expect(readRefusal('FROM a:1\nRUN cat <<EOF\nFROM evil/x:1\n')).toContain(
    'the heredoc EOF is not closed',
  );
});

test('an instruction whose name is not ASCII is refused', () => {
  expect(readRefusal('FROM a:1\nONBU\u0130LD ADD http://x /x')).toContain('is not ASCII');
});

test('a remote ADD source is refused, in the shell and the JSON form', () => {
  const sources = [
    'http://127.0.0.1:9/x',
    'https://example.invalid/x.tar',
    'git://example.invalid/repo.git',
    'ssh://git@example.invalid/repo.git',
    'git@example.invalid:org/repo.git',
    'HTTP://169.254.169.254/latest',
  ];

  for (const source of sources) {
    expect(readRefusal(`FROM a:1\nADD ${source} /x`)).toContain(`ADD ${source} is refused`);
    expect(readRefusal(`FROM a:1\nADD ["${source}", "/x"]`)).toContain(`ADD ${source} is refused`);
  }

  // JSON decodes its escapes before the check
  const escaped = String.raw`ADD ["\u0068ttp://x/y", "/x"]`;

  expect(readRefusal(`FROM a:1\n${escaped}`)).toContain('ADD http://x/y is refused');

  expect(readRefusal('FROM a:1\nADD --checksum=sha256:00 ./a http://x/y /x')).toContain(
    'ADD http://x/y is refused',
  );

  // local sources, and github.com/ paths, which the frontend reads as local
  expect(listBaseImages('FROM a:1\nADD app.tar /app\nADD github.com/org/repo /src')).toEqual([
    'a:1',
  ]);
});

test('a variable in FROM, an ADD source, COPY --from or RUN --mount from is refused', () => {
  const refusals = [
    'ARG BASE=a:1\nFROM $BASE',
    'FROM registry.example/x:$TAG',
    'ARG URL=http://x\nFROM a:1\nADD $URL /x',
    `FROM a:1\nADD ["\${URL}", "/x"]`,
    'FROM a:1\nCOPY --from=$IMAGE /a /b',
    'FROM a:1\nRUN --mount=type=bind,from=$IMAGE,target=/m true',
  ].map((dockerfile) => readRefusal(dockerfile));

  for (const refusal of refusals) {
    expect(refusal).toContain('variable, which impd cannot check');
  }
});

test('ONBUILD is refused, in the Dockerfile and in a stage a later FROM uses', () => {
  const plain = readRefusal('FROM a:1\nONBUILD ADD http://x /x');
  const staged = readRefusal('FROM a:1 AS base\nONBUILD RUN true\nFROM base\nRUN true');
  const lower = readRefusal('FROM a:1\nonbuild RUN true');

  for (const refusal of [plain, staged, lower]) {
    expect(refusal).toContain('ONBUILD is refused');
  }
});

test('FROM --platform may name only the build or target platform variable, as written', () => {
  expect(
    checkDockerfile('FROM --platform=$BUILDPLATFORM a:1\nFROM --platform=$TARGETPLATFORM b:1'),
  ).toEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'b:1', use: 'FROM' },
  ]);

  for (const value of [
    'linux/arm64',
    ['$', '{BUILDPLATFORM}'].join(''),
    '$BUILDPLATFORM/v8',
    '$BUILDOS/amd64',
  ]) {
    expect(readRefusal(`FROM --platform=${value} a:1`)).toContain(
      `FROM --platform=${value} is refused`,
    );
  }
});

test('an ARG of a platform variable is refused, in any stage and behind quotes', () => {
  const global = readRefusal('ARG BUILDPLATFORM=linux/arm64\nFROM --platform=$BUILDPLATFORM a:1');
  const staged = readRefusal('FROM a:1\nARG TARGETPLATFORM');
  const quoted = readRefusal('ARG A=1 "targetarch"=arm64\nFROM a:1');

  const escaped = readRefusal(String.raw`ARG BUILD\OS=x
FROM a:1`);

  expect(global).toContain('line 1: ARG BUILDPLATFORM is refused');
  expect(staged).toContain('line 2: ARG TARGETPLATFORM is refused');
  expect(quoted).toContain('ARG targetarch is refused');
  expect(escaped).toContain('ARG BUILDOS is refused');
  expect(checkDockerfile('ARG VERSION="1.2" PLATFORM_NOTE\nFROM a:1')).toBeDefined();
});

const PINS = new Map([
  ['a:1', 'a@sha256:1111'],
  ['b:2', 'b@sha256:2222'],
  ['c:3', 'c@sha256:3333'],
]);

test('the pinned copy names each image by its pin and the platform outright', () => {
  const dockerfile = [
    '# escape=\\',
    'FROM --platform=$BUILDPLATFORM a:1 AS build',
    'COPY --from=b:2 /x /x',
    'RUN --mount=type=bind,from=c:3,target=/c --mount=from=build,target=/b true',
    'FROM build',
    'COPY --from=build /x /y',
    'FROM a:1',
    '',
  ].join('\n');

  expect(renderPinnedDockerfile(dockerfile, PINS, 'linux/amd64')).toBe(
    [
      '# escape=\\',
      'FROM --platform=linux/amd64 a@sha256:1111 AS build',
      'COPY --from=b@sha256:2222 /x /x',
      'RUN --mount=type=bind,from=c@sha256:3333,target=/c --mount=from=build,target=/b true',
      'FROM build',
      'COPY --from=build /x /y',
      'FROM a@sha256:1111',
      '',
    ].join('\n'),
  );
});

// the frontend joins a continuation without its newline, and a heredoc's
// body is read after the instruction's own lines
test('a pinned instruction is joined onto one line, and a heredoc body is kept as it is', () => {
  const body = ['  echo "$HOME" \\', '# not a comment here', 'EOF'];

  const dockerfile = [
    'from a:1',
    'RUN --mount=from=c:3,target=/c \\',
    '# a comment in the continuation',
    '    sh <<EOF',
    ...body,
    'COPY \\',
    '  --from=b:2 ["/x", "/y"]',
  ].join('\r\n');

  expect(renderPinnedDockerfile(dockerfile, PINS, 'linux/amd64')).toBe(
    [
      'from a@sha256:1111',
      'RUN --mount=from=c@sha256:3333,target=/c sh <<EOF',
      ...body,
      'COPY --from=b@sha256:2222 ["/x", "/y"]',
    ].join('\r\n'),
  );
});

test('the pinned copy needs a pin for every image the build names', () => {
  expect(() => renderPinnedDockerfile('FROM d:4', PINS, 'linux/amd64')).toThrow(
    'line 1: FROM d:4 has no pin',
  );
});

test('COPY --from and RUN --mount from name an image unless they name a stage', () => {
  const dockerfile = [
    'FROM a:1 AS build',
    'COPY --from=build /a /a',
    'COPY --from=0 /a /b',
    'COPY --from=LATER /a /c',
    'COPY --from=scratch /a /d',
    'COPY --from=registry.example/tools:2 /bin/x /x',
    'RUN --mount=type=bind,from=alpine:3.21,target=/m --mount=type=cache,target=/c true',
    'RUN --mount=type=cache,FROM=build,target=/c true',
    'FROM b:1 AS later',
  ].join('\n');

  expect(checkDockerfile(dockerfile)).toEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'registry.example/tools:2', use: 'COPY --from' },
    { ref: 'alpine:3.21', use: 'RUN --mount from' },
    { ref: 'b:1', use: 'FROM' },
  ]);
});

test('a Dockerfile with no instructions, or an instruction with no name, is refused', () => {
  expect(readRefusal('# only a comment\n\n')).toContain('has no instructions');
  expect(readRefusal('FROM a:1\n\\\n')).toContain('an instruction has no name');
});
