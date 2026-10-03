import { expect, test } from 'bun:test';
import { listBaseImages } from './dockerfile-check';
import { DockerfileError } from './dockerfile-error';

test('it lists each FROM image once, past flags and stage names', () => {
  const dockerfile = [
    '# syntax=docker/dockerfile:1',
    'FROM --platform=$BUILDPLATFORM golang:1.26 AS build',
    'RUN go build',
    'from ghcr.io/acme/base:2 as Runtime',
    'COPY --from=build /out /out',
    'FROM golang:1.26',
  ].join('\n');

  expect(listBaseImages(dockerfile)).toEqual(['golang:1.26', 'ghcr.io/acme/base:2']);
});

// the frontend matches a base to a stage as written: `FROM TOOLS` is an
// image, which then fails as a reference
test('it leaves out scratch, earlier stages and images an ARG names', () => {
  const dockerfile = [
    'ARG BASE=ubuntu:24.04',
    'FROM scratch AS empty',
    'FROM $BASE AS base',
    'FROM busybox:1.37 AS Tools',
    'FROM tools',
    'FROM TOOLS',
    'FROM empty',
    'FROM registry.example/x:$TAG',
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
  expect(listBaseImages('FROM a:1\nADD h`ttp://x /probe')).toEqual(['a:1']);
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
