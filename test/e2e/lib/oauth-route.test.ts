import { expect, test } from 'bun:test';
import { buildPkceChallenge, parseApprovalPage, parseMcpBody } from './oauth-route';

test('#buildPkceChallenge gives RFC 7636 appendix B challenge', () => {
  expect(buildPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('#parseApprovalPage reads the approval code and the form fields', () => {
  const page = [
    '<p>Run <code>imp oauth approve K7QX-29TB</code> to approve.</p>',
    '<form method="post">',
    '<input type="hidden" name="id" value="req_01">',
    '<input type="hidden" name="signature" value="c2lnbmVk">',
    '</form>',
  ].join('\n');

  expect(parseApprovalPage(page)).toStrictEqual({
    code: 'K7QX-29TB',
    id: 'req_01',
    signature: 'c2lnbmVk',
  });
});

test('#parseApprovalPage reads a page without the form as empty fields', () => {
  expect(parseApprovalPage('<p>expired</p>')).toStrictEqual({ code: '', id: '', signature: '' });
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
