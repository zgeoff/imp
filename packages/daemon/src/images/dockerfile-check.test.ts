import { expect, test } from 'bun:test';
import { checkDockerfile, renderPinnedDockerfile } from './dockerfile-check';
import { DockerfileError } from './dockerfile-error';

test('#renderPinnedDockerfile names each image of the pinned copy by its pin and the platform outright', () => {
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

  const pins = new Map([
    ['a:1', 'a@sha256:1111'],
    ['b:2', 'b@sha256:2222'],
    ['c:3', 'c@sha256:3333'],
  ]);

  expect(renderPinnedDockerfile(dockerfile, pins, 'linux/amd64')).toBe(
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

test('#renderPinnedDockerfile renders the same pinned copy from the same Dockerfile and pins', () => {
  const dockerfile = 'FROM a:1 AS build\nCOPY --from=b:2 /x /x\nFROM build\n';

  const pins = new Map([
    ['a:1', 'a@sha256:1111'],
    ['b:2', 'b@sha256:2222'],
  ]);

  expect(renderPinnedDockerfile(dockerfile, pins, 'linux/amd64')).toStrictEqual(
    renderPinnedDockerfile(dockerfile, pins, 'linux/amd64'),
  );
});

// the frontend joins a continuation without its newline, and a heredoc's
// body is read after the instruction's own lines
test('#renderPinnedDockerfile joins a pinned instruction onto one line and keeps a heredoc body as it is', () => {
  const dockerfile = [
    'from a:1',
    'RUN --mount=from=c:3,target=/c \\',
    '# a comment in the continuation',
    '    sh <<EOF',
    '  echo "$HOME" \\',
    '# not a comment here',
    'EOF',
    'COPY \\',
    '  --from=b:2 ["/x", "/y"]',
  ].join('\r\n');

  const pins = new Map([
    ['a:1', 'a@sha256:1111'],
    ['b:2', 'b@sha256:2222'],
    ['c:3', 'c@sha256:3333'],
  ]);

  expect(renderPinnedDockerfile(dockerfile, pins, 'linux/amd64')).toBe(
    [
      'from a@sha256:1111',
      'RUN --mount=from=c@sha256:3333,target=/c sh <<EOF',
      '  echo "$HOME" \\',
      '# not a comment here',
      'EOF',
      'COPY --from=b@sha256:2222 ["/x", "/y"]',
    ].join('\r\n'),
  );
});

test('#renderPinnedDockerfile refuses to render a pinned copy for an image that has no pin', () => {
  expect(() =>
    renderPinnedDockerfile('FROM d:4', new Map([['a:1', 'a@sha256:1111']]), 'linux/amd64'),
  ).toThrowWithMessage(DockerfileError, 'line 1: FROM d:4 has no pin');
});

// a pin that adds words would change the stage the instruction names
test('#renderPinnedDockerfile refuses a pinned copy that does not parse back to the same instructions', () => {
  expect(() =>
    renderPinnedDockerfile(
      'FROM a:1\nRUN true\n',
      new Map([['a:1', 'a@sha256:1111 AS other']]),
      'linux/amd64',
    ),
  ).toThrowWithMessage(DockerfileError, 'impd could not pin the images this Dockerfile names');
});

test('#checkDockerfile lists each FROM image once, past stage names', () => {
  const dockerfile = [
    '# syntax=docker/dockerfile:1',
    'FROM golang:1.26 AS build',
    'RUN go build',
    'from ghcr.io/acme/base:2 as Runtime',
    'COPY --from=build /out /out',
    'FROM golang:1.26',
  ].join('\n');

  expect(checkDockerfile(dockerfile)).toStrictEqual([
    { ref: 'golang:1.26', use: 'FROM' },
    { ref: 'ghcr.io/acme/base:2', use: 'FROM' },
  ]);
});

// the frontend matches a base to a stage as written: `FROM TOOLS` is an
// image, which then fails as a reference
test('#checkDockerfile leaves out scratch and earlier stages named as written', () => {
  const dockerfile = [
    'FROM scratch AS empty',
    'FROM busybox:1.37 AS Tools',
    'FROM tools',
    'FROM TOOLS',
    'FROM empty',
  ].join('\n');

  expect(checkDockerfile(dockerfile)).toStrictEqual([
    { ref: 'busybox:1.37', use: 'FROM' },
    { ref: 'TOOLS', use: 'FROM' },
  ]);
});

test('#checkDockerfile joins continuations and skips the comments and blank lines in them', () => {
  expect(
    checkDockerfile('FROM \\\n  # a comment\n\n  alpine:3.20 \\\n  AS a\nFROM a\n'),
  ).toStrictEqual([{ ref: 'alpine:3.20', use: 'FROM' }]);
});

test('#checkDockerfile continues lines with the escape a directive sets', () => {
  expect(
    checkDockerfile('# escape=`\nFROM `\n  alpine:3.21\nRUN dir C:\\\nFROM debian:13\n'),
  ).toStrictEqual([
    { ref: 'alpine:3.21', use: 'FROM' },
    { ref: 'debian:13', use: 'FROM' },
  ]);
});

test('#checkDockerfile reads no instruction in a heredoc body', () => {
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

  expect(checkDockerfile(dockerfile)).toStrictEqual([
    { ref: 'alpine:3.20', use: 'FROM' },
    { ref: 'busybox:1.37', use: 'FROM' },
  ]);
});

test('#checkDockerfile opens no heredoc for a << inside a quoted string', () => {
  const dockerfile = [
    'FROM alpine:3.20',
    `RUN echo "<<EOF" && echo 'a <<-END b' && echo "say \\"<<NOTE\\""`,
    'FROM busybox:1.37',
    'RUN cat <<"EOF" >/a',
    'FROM evil/inside:1',
    'EOF',
    'FROM debian:13',
  ].join('\n');

  expect(checkDockerfile(dockerfile)).toStrictEqual([
    { ref: 'alpine:3.20', use: 'FROM' },
    { ref: 'busybox:1.37', use: 'FROM' },
    { ref: 'debian:13', use: 'FROM' },
  ]);
});

test.each([
  ['FROM a:1\nADD h"ttp:"//example.invalid/probe /probe'],
  ["FROM a:1\nADD h'ttp://'example.invalid/probe /probe"],
  ['FROM a:1\nADD h\\ttp://example.invalid/probe /probe'],
  ['FROM a:1\nADD ["h\\"ttp:\\"//example.invalid/probe", "/probe"]'],
  ['# escape=`\nFROM a:1\nADD h`ttp://example.invalid/probe /probe'],
])('#checkDockerfile refuses the ADD source of %j as an ambiguous form', (dockerfile) => {
  expect(() => checkDockerfile(dockerfile)).toThrowWithMessage(
    DockerfileError,
    /^line \d: an ambiguous form: the ADD source /v,
  );
});

test('#checkDockerfile reads a backtick in an ADD source as its own character under the default escape', () => {
  expect(checkDockerfile('FROM a:1\nADD h`ttp /probe')).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
  ]);
});

test.each([
  ['FROM a:1\nCOPY --from="evil/x:1" /a /b', 'line 2: an ambiguous form: the COPY flags'],
  [
    "FROM a:1\nRUN --mount=type=bind,from='evil/x:1' true",
    'line 2: an ambiguous form: the RUN flags',
  ],
  [String.raw`FROM --platform=linux\/amd64 a:1`, 'line 1: an ambiguous form: the FROM flags'],
  ['FROM "evil/x:1"', 'line 1: an ambiguous form: the FROM word'],
  ['FROM a:1\nCOPY --from=\u0435vil /a /b', 'line 2: an ambiguous form: the COPY flags'],
])(
  '#checkDockerfile refuses the flags or words of %j as an ambiguous form',
  (dockerfile, refusal) => {
    expect(() => checkDockerfile(dockerfile)).toThrowWithMessage(
      DockerfileError,
      new RegExp(`^${RegExp.escape(refusal)} `, 'v'),
    );
  },
);

// the escape directive does not hold after the comment: the backtick is
// no continuation, and FROM a:1 ` is a FROM of three words
test('#checkDockerfile ends the parser directives at the first other line', () => {
  expect(checkDockerfile('# hello\n# escape=`\nFROM a:1 `\nFROM b:1\n')).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'b:1', use: 'FROM' },
  ]);
});

test('#checkDockerfile reads a parser directive after a byte order mark', () => {
  expect(checkDockerfile('\uFEFF# escape=`\nFROM `\n  c:1\n')).toStrictEqual([
    { ref: 'c:1', use: 'FROM' },
  ]);
});

test('#checkDockerfile refuses a parser directive given twice', () => {
  expect(() => checkDockerfile('# escape=`\n# escape=\\\nFROM a:1')).toThrowWithMessage(
    DockerfileError,
    'the Dockerfile has more than one escape parser directive',
  );
});

test('#checkDockerfile ends no continuation on a line ending in an escaped escape character', () => {
  expect(checkDockerfile('FROM a:1\nRUN echo \\\\\nFROM b:1\n')).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'b:1', use: 'FROM' },
  ]);
});

test('#checkDockerfile opens no heredoc for a LABEL', () => {
  expect(checkDockerfile('FROM a:1\nLABEL note=<<EOF\nFROM evil/label:1\n')).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'evil/label:1', use: 'FROM' },
  ]);
});

test('#checkDockerfile opens no heredoc for a RUN in the JSON form', () => {
  expect(
    checkDockerfile('FROM a:1\nRUN ["sh", "-c", "cat <<EOF"]\nFROM evil/json:1\n'),
  ).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'evil/json:1', use: 'FROM' },
  ]);
});

test('#checkDockerfile opens a heredoc whose word follows << after a space', () => {
  expect(
    checkDockerfile('FROM a:1\nRUN cat << EOF\nFROM evil/spaced:1\nEOF\nFROM b:1\n'),
  ).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'b:1', use: 'FROM' },
  ]);
});

test('#checkDockerfile opens no heredoc for a << behind a quote that is never closed', () => {
  expect(checkDockerfile('FROM a:1\nRUN echo "<<EOF\nFROM evil/quote:1\n')).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'evil/quote:1', use: 'FROM' },
  ]);
});

test('#checkDockerfile refuses a braced expansion on a line that opens a heredoc', () => {
  expect(() => checkDockerfile(`FROM a:1\nRUN cat <<EOF \${X:-a b}\nEOF\n`)).toThrowWithMessage(
    DockerfileError,
    `line 2: an ambiguous form: \${...} on a line that holds <<`,
  );
});

test('#checkDockerfile refuses a heredoc that is never closed', () => {
  expect(() => checkDockerfile('FROM a:1\nRUN cat <<EOF\nFROM evil/x:1\n')).toThrowWithMessage(
    DockerfileError,
    'line 2: the heredoc EOF is not closed',
  );
});

test('#checkDockerfile refuses an instruction whose name is not ASCII', () => {
  expect(() => checkDockerfile('FROM a:1\nONBU\u0130LD ADD http://x /x')).toThrowWithMessage(
    DockerfileError,
    'line 2: the instruction "ONBU\u0130LD" is not ASCII',
  );
});

test.each([
  ['http://127.0.0.1:9/x'],
  ['https://example.invalid/x.tar'],
  ['git://example.invalid/repo.git'],
  ['ssh://git@example.invalid/repo.git'],
  ['git@example.invalid:org/repo.git'],
  ['HTTP://169.254.169.254/latest'],
])('#checkDockerfile refuses the remote ADD source %s in the shell form', (source) => {
  expect(() => checkDockerfile(`FROM a:1\nADD ${source} /x`)).toThrowWithMessage(
    DockerfileError,
    `line 2: ADD ${source} is refused: the engine would fetch it from the host's network; fetch it in a RUN step, or send it in the context`,
  );
});

test.each([
  ['http://127.0.0.1:9/x'],
  ['https://example.invalid/x.tar'],
  ['git://example.invalid/repo.git'],
  ['ssh://git@example.invalid/repo.git'],
  ['git@example.invalid:org/repo.git'],
  ['HTTP://169.254.169.254/latest'],
])('#checkDockerfile refuses the remote ADD source %s in the JSON form', (source) => {
  expect(() => checkDockerfile(`FROM a:1\nADD ["${source}", "/x"]`)).toThrowWithMessage(
    DockerfileError,
    `line 2: ADD ${source} is refused: the engine would fetch it from the host's network; fetch it in a RUN step, or send it in the context`,
  );
});

test('#checkDockerfile refuses a remote ADD source written with a JSON escape', () => {
  expect(() =>
    checkDockerfile(String.raw`FROM a:1
ADD ["\u0068ttp://x/y", "/x"]`),
  ).toThrowWithMessage(DockerfileError, /^line 2: ADD http:\/\/x\/y is refused: /v);
});

test('#checkDockerfile refuses a remote ADD source behind a builder flag and a local source', () => {
  expect(() =>
    checkDockerfile('FROM a:1\nADD --checksum=sha256:00 ./a http://x/y /x'),
  ).toThrowWithMessage(DockerfileError, /^line 2: ADD http:\/\/x\/y is refused: /v);
});

test('#checkDockerfile accepts local ADD sources, and github.com paths the frontend reads as local', () => {
  expect(checkDockerfile('FROM a:1\nADD app.tar /app\nADD github.com/org/repo /src')).toStrictEqual(
    [{ ref: 'a:1', use: 'FROM' }],
  );
});

test.each([
  ['ARG BASE=a:1\nFROM $BASE'],
  ['FROM registry.example/x:$TAG'],
  ['ARG URL=http://x\nFROM a:1\nADD $URL /x'],
  [`FROM a:1\nADD ["\${URL}", "/x"]`],
  ['FROM a:1\nCOPY --from=$IMAGE /a /b'],
  ['FROM a:1\nRUN --mount=type=bind,from=$IMAGE,target=/m true'],
])('#checkDockerfile refuses the image or source variable in %j', (dockerfile) => {
  expect(() => checkDockerfile(dockerfile)).toThrowWithMessage(
    DockerfileError,
    /variable, which impd cannot check$/v,
  );
});

test.each([
  ['FROM a:1\nONBUILD ADD http://x /x'],
  ['FROM a:1 AS base\nONBUILD RUN true\nFROM base\nRUN true'],
  ['FROM a:1\nonbuild RUN true'],
])('#checkDockerfile refuses the ONBUILD of %j', (dockerfile) => {
  expect(() => checkDockerfile(dockerfile)).toThrowWithMessage(
    DockerfileError,
    'line 2: ONBUILD is refused: impd checks only the instructions this build runs',
  );
});

test('#checkDockerfile accepts FROM --platform naming the build or target platform variable', () => {
  expect(
    checkDockerfile('FROM --platform=$BUILDPLATFORM a:1\nFROM --platform=$TARGETPLATFORM b:1'),
  ).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'b:1', use: 'FROM' },
  ]);
});

test.each([['linux/arm64'], [`\${BUILDPLATFORM}`], ['$BUILDPLATFORM/v8'], ['$BUILDOS/amd64']])(
  '#checkDockerfile refuses FROM --platform=%s',
  (value) => {
    expect(() => checkDockerfile(`FROM --platform=${value} a:1`)).toThrowWithMessage(
      DockerfileError,
      `line 1: FROM --platform=${value} is refused: impd builds for the host's platform only; use $BUILDPLATFORM or $TARGETPLATFORM, or leave it out`,
    );
  },
);

test.each([
  [
    'ARG BUILDPLATFORM=linux/arm64\nFROM --platform=$BUILDPLATFORM a:1',
    'line 1: ARG BUILDPLATFORM',
  ],
  ['FROM a:1\nARG TARGETPLATFORM', 'line 2: ARG TARGETPLATFORM'],
  ['ARG A=1 "targetarch"=arm64\nFROM a:1', 'line 1: ARG targetarch'],
  ['ARG BUILD\\OS=x\nFROM a:1', 'line 1: ARG BUILDOS'],
])('#checkDockerfile refuses the platform variable ARG in %j', (dockerfile, refusal) => {
  expect(() => checkDockerfile(dockerfile)).toThrowWithMessage(
    DockerfileError,
    `${refusal} is refused: the build's platform variables are the host's, and impd checks images for that platform`,
  );
});

test('#checkDockerfile refuses an ARG that names its variable with a variable', () => {
  expect(() => checkDockerfile('ARG $NAME=x\nFROM a:1')).toThrowWithMessage(
    DockerfileError,
    'line 1: ARG $NAME names its variable with a variable, which impd cannot check',
  );
});

test.each([
  ['ARG VERSION="1.2" PLATFORM_NOTE'],
  ['ARG DESCRIPTION="Build for TARGETARCH"'],
  ['ARG A=1 B="x y"'],
  [`ARG D="TARGETPLATFORM=linux/arm64" E='BUILDOS x'`],
])('#checkDockerfile accepts the ARG %s that only mentions a platform variable', (line) => {
  expect(checkDockerfile(`${line}\nFROM a:1`)).toStrictEqual([{ ref: 'a:1', use: 'FROM' }]);
});

test('#checkDockerfile reads COPY --from as a stage index where Go reads an int', () => {
  expect(
    checkDockerfile('FROM a:1\nFROM b:1\nCOPY --from=+1 /x /x\nCOPY --from=0 /y /y'),
  ).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'b:1', use: 'FROM' },
  ]);
});

test.each([
  ['1', 'line 2: COPY --from=1 names no stage: the Dockerfile has 1'],
  ['-1', 'line 2: COPY --from=-1 names no stage: the Dockerfile has 1'],
])('#checkDockerfile refuses the stage index COPY --from=%s out of range', (from, refusal) => {
  expect(() => checkDockerfile(`FROM a:1\nCOPY --from=${from} /x /x`)).toThrowWithMessage(
    DockerfileError,
    refusal,
  );
});

// past int64, Atoi fails and the frontend reads an image
test('#checkDockerfile reads a COPY --from number past int64 as an image', () => {
  expect(checkDockerfile('FROM a:1\nCOPY --from=99999999999999999999 /x /x')).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: '99999999999999999999', use: 'COPY --from' },
  ]);
});

test('#checkDockerfile lists COPY --from and RUN --mount from images unless they name a stage', () => {
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

  expect(checkDockerfile(dockerfile)).toStrictEqual([
    { ref: 'a:1', use: 'FROM' },
    { ref: 'registry.example/tools:2', use: 'COPY --from' },
    { ref: 'alpine:3.21', use: 'RUN --mount from' },
    { ref: 'b:1', use: 'FROM' },
  ]);
});

test('#checkDockerfile refuses a Dockerfile with no instructions', () => {
  expect(() => checkDockerfile('# only a comment\n\n')).toThrowWithMessage(
    DockerfileError,
    'the Dockerfile has no instructions',
  );
});

test('#checkDockerfile refuses an instruction with no name', () => {
  expect(() => checkDockerfile('FROM a:1\n\\\n')).toThrowWithMessage(
    DockerfileError,
    'line 2: an instruction has no name',
  );
});
