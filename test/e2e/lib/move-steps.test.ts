import { expect, test } from 'bun:test';
import { createInstance } from './instance';
import {
  buildUpstreamsPath,
  parseHostListing,
  parseNftSetAddresses,
  parseRpcAnswer,
} from './move-steps';

test('#buildUpstreamsPath names the upstreams file in the host’s data dir', () => {
  const host = createInstance({
    container: 'imp-e2e-mv-b',
    dataDir: '/srv/imp/.data/e2e-mv-b',
    network: 'imp-e2e-mv',
    ip: '10.100.0.11',
  });

  expect(buildUpstreamsPath(host)).toBe('/srv/imp/.data/e2e-mv-b/broker-test-upstreams.json');
});

test('#parseRpcAnswer reads the json of an answer', () => {
  expect(parseRpcAnswer(false, { json: { code: 'LEASED', message: 'held' } })).toStrictEqual({
    ok: false,
    body: { code: 'LEASED', message: 'held' },
  });
});

test('#parseRpcAnswer rejects an answer without json', () => {
  expect(() => parseRpcAnswer(true, { result: 1 })).toThrow();
});

test('#parseHostListing keeps the rows and imps that name the imp on each host', () => {
  const table = [
    'HOST  NAME        STATE    MOVE',
    'a     e2e-mv-seen stopped  sending',
    'a     e2e-mv-other running',
    'b     e2e-mv-seen-2 running',
    '',
  ].join('\n');

  const json = JSON.stringify({
    imps: [
      { host: 'a', name: 'e2e-mv-seen', move: 'sending', state: 'stopped' },
      { host: 'a', name: 'e2e-mv-other', state: 'running' },
      { host: 'b', name: 'e2e-mv-seen-2', state: 'running' },
    ],
  });

  expect(parseHostListing(table, json, 'e2e-mv-seen')).toStrictEqual({
    rows: ['a     e2e-mv-seen stopped  sending'],
    imps: [{ host: 'a', name: 'e2e-mv-seen', move: 'sending' }],
  });
});

test('#parseNftSetAddresses reads the IPv4 elements of a set', () => {
  const listed = [
    'table inet imp_egress {',
    '\tset allow4 {',
    '\t\ttype ipv4_addr',
    '\t\telements = { 93.184.215.14, 140.82.112.5,',
    '\t\t\t     140.82.112.6 }',
    '\t}',
    '}',
  ].join('\n');

  expect(parseNftSetAddresses(listed)).toStrictEqual([
    '93.184.215.14',
    '140.82.112.5',
    '140.82.112.6',
  ]);
});

test('#parseNftSetAddresses reads a set without elements as none', () => {
  expect(parseNftSetAddresses('table inet imp_egress {\n\tset allow4 {\n\t}\n}')).toStrictEqual([]);
});
