import { expect, test } from 'bun:test';
import {
  buildPkceChallenge,
  buildRouteOrigin,
  parseApprovalPage,
  parseMcpBody,
  readCookies,
} from './oauth-route';

test('#buildRouteOrigin publishes the route at the instance’s port offset', () => {
  expect(buildRouteOrigin({ portOffset: 700 })).toBe('http://127.0.0.1:7771');
});

test('#buildPkceChallenge gives RFC 7636 appendix B challenge', () => {
  expect(buildPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('#parseApprovalPage reads the approval code and the signed query, unescaped', () => {
  const page = [
    '<p>Run <code>impz oauth approve K7QX-29TB</code> to approve.</p>',
    '<form method="post" action="/login">',
    '<input type="hidden" name="oauth_query" value="client_id=impc_a&amp;sig=c2ln">',
    '</form>',
  ].join('\n');

  expect(parseApprovalPage(page)).toStrictEqual({
    code: 'K7QX-29TB',
    oauthQuery: 'client_id=impc_a&sig=c2ln',
  });
});

test('#parseApprovalPage reads a page without the form as empty fields', () => {
  expect(parseApprovalPage('<p>expired</p>')).toStrictEqual({ code: '', oauthQuery: '' });
});

test('#readCookies sends back each cookie a response sets, without its attributes', () => {
  const headers = new Headers();

  headers.append('set-cookie', 'session=abc; Path=/; HttpOnly');
  headers.append('set-cookie', 'data=xyz; Max-Age=60');

  expect(readCookies(new Response(null, { headers }))).toBe('session=abc; data=xyz');
});

test('#parseMcpBody reads the last event of a stream', () => {
  const text = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
    '',
    ': keepalive',
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{}}',
    '',
  ].join('\n');

  expect(parseMcpBody(text)).toStrictEqual({ jsonrpc: '2.0', id: 1, result: {} });
});

test('#parseMcpBody reads a JSON body', () => {
  expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}')).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {},
  });
});

test('#parseMcpBody reads a body that is not JSON as its text', () => {
  expect(parseMcpBody('Unauthorized')).toBe('Unauthorized');
});
