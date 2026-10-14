import { expect, test } from 'bun:test';
import { buildContainerCurlArgv, parseContainerCurl, readWakeMs } from './container-https';

test('#buildContainerCurlArgv resolves an https name to loopback on 443', () => {
  expect(buildContainerCurlArgv('https://a.imp.test/')).toStrictEqual([
    'curl',
    '-sS',
    '--max-time',
    '30',
    '--cacert',
    '/src/.cache/e2e/pebble-root.pem',
    '--resolve',
    'a.imp.test:443:127.0.0.1',
    '-D',
    '/dev/stderr',
    '-o',
    '/dev/stdout',
    '-w',
    '\nimp-e2e-time-total:%{time_total}',
    'https://a.imp.test/',
  ]);
});

test('#buildContainerCurlArgv keeps the port of the URL and adds the Host and Authorization headers', () => {
  expect(
    buildContainerCurlArgv('http://a.imp.test:8443/x', {
      host: 'b.imp.test',
      authorization: 'Bearer t',
    }),
  ).toStrictEqual([
    'curl',
    '-sS',
    '--max-time',
    '30',
    '--cacert',
    '/src/.cache/e2e/pebble-root.pem',
    '--resolve',
    'a.imp.test:8443:127.0.0.1',
    '-D',
    '/dev/stderr',
    '-o',
    '/dev/stdout',
    '-w',
    '\nimp-e2e-time-total:%{time_total}',
    '-H',
    'Host: b.imp.test',
    '-H',
    'Authorization: Bearer t',
    'http://a.imp.test:8443/x',
  ]);
});

test('#buildContainerCurlArgv resolves a plain http name on 80', () => {
  expect(buildContainerCurlArgv('http://a.imp.test/')).toStrictEqual([
    'curl',
    '-sS',
    '--max-time',
    '30',
    '--cacert',
    '/src/.cache/e2e/pebble-root.pem',
    '--resolve',
    'a.imp.test:80:127.0.0.1',
    '-D',
    '/dev/stderr',
    '-o',
    '/dev/stdout',
    '-w',
    '\nimp-e2e-time-total:%{time_total}',
    'http://a.imp.test/',
  ]);
});

test('#readWakeMs reads the wake time impd reports', () => {
  expect(readWakeMs('HTTP/1.1 200 OK\r\nX-Imp-Wake-Ms: 41\r\n\r\n')).toBe(41);
});

test('#readWakeMs throws on a response that reports no wake', () => {
  expect(() => readWakeMs('HTTP/1.1 200 OK\r\n\r\n')).toThrowWithMessage(
    Error,
    'the response reports no x-imp-wake-ms',
  );
});

test('#parseContainerCurl reads the status, headers, body and total time', () => {
  const stderr = 'HTTP/2 200 \r\nx-imp-wake-ms: 41\r\n\r\n';

  expect(parseContainerCurl('e2e-tiny-ok\n\nimp-e2e-time-total:0.1234', stderr)).toStrictEqual({
    status: 200,
    headers: stderr,
    body: 'e2e-tiny-ok',
    totalMs: 123,
  });
});

test('#parseContainerCurl reads output without a status line as status 0', () => {
  expect(parseContainerCurl('\nimp-e2e-time-total:0.002', '')).toStrictEqual({
    status: 0,
    headers: '',
    body: '',
    totalMs: 2,
  });
});
