import { expect, test } from 'bun:test';
import { listBaseImages } from './dockerfile-bases';

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

test('it leaves out scratch, earlier stages and images an ARG names', () => {
  const dockerfile = [
    'ARG BASE=ubuntu:24.04',
    'FROM scratch AS empty',
    'FROM $BASE AS base',
    'FROM busybox:1.37 AS tools',
    'FROM TOOLS',
    'FROM empty',
    'FROM registry.example/x:$TAG',
  ].join('\n');

  expect(listBaseImages(dockerfile)).toEqual(['busybox:1.37']);
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
