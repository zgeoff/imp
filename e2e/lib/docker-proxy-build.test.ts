import { expect, test } from 'bun:test';
import { buildProxyBuildScript, parseProxyAnswer } from './docker-proxy-build';

test('#buildProxyBuildScript posts a tar context with every param in order, repeats included', () => {
  const script = buildProxyBuildScript(
    [
      ['t', 'imp/a:latest'],
      ['t', 'imp/b:latest'],
      ['version', '2'],
    ],
    '/build',
    '/run/imp-docker/host-mode.sock',
  );

  expect(script).toBe(
    [
      String.raw`d=$(mktemp -d) && printf "FROM busybox\n" >"$d/Dockerfile" &&`,
      'tar -C "$d" -c Dockerfile | curl -sS --unix-socket /run/imp-docker/host-mode.sock',
      "-X POST -H 'Content-Type: application/x-tar' --data-binary @-",
      "-w ' %{http_code}' 'http://docker/build?t=imp%2Fa%3Alatest&t=imp%2Fb%3Alatest&version=2'",
    ].join(' '),
  );
});

test('#buildProxyBuildScript posts to another path with no params', () => {
  expect(buildProxyBuildScript([], '/grpc', '/run/x.sock')).toEndWith("'http://docker/grpc?'");
});

test('#parseProxyAnswer reads the status after the body and the message in it', () => {
  expect(
    parseProxyAnswer('{"message":"imp-docker-proxy: param t is not allowed"} 403'),
  ).toStrictEqual({ status: 403, message: 'imp-docker-proxy: param t is not allowed' });
});

test('#parseProxyAnswer rejects output with no status', () => {
  expect(() => parseProxyAnswer('{}')).toThrowWithMessage(Error, 'no status in "{}"');
});

test('#parseProxyAnswer rejects a body that is not a refusal', () => {
  expect(() => parseProxyAnswer('{"stream":"Step 1/1"} 200')).toThrow(
    expect.objectContaining({
      issues: expect.toPartiallyContain({ path: ['message'], code: 'invalid_type' }),
    }),
  );
});
