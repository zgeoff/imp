import { expect, test } from 'bun:test';
import {
  findServiceUrl,
  findTailnetNode,
  isTailnetReady,
  parseSelfTags,
  parseTailscaleStatus,
  requireTailnetReady,
} from './tailnet';

test('#findServiceUrl picks the per-imp tailnet name among the URL lines', () => {
  const stdout = [
    'http://e2e-mvt-n.imp.localhost:7080/',
    'http://100.64.0.7:8004/',
    'https://e2e-e2e-mvt-n.tail1234.ts.net',
    '',
  ].join('\n');

  expect(findServiceUrl(stdout)).toBe('https://e2e-e2e-mvt-n.tail1234.ts.net');
});

test('#findServiceUrl gives null before the imp has a tailnet name', () => {
  expect(findServiceUrl('http://e2e-mvt-n.imp.localhost:7080/\n')).toBeNull();
});

test('#isTailnetReady is ready with a key and this machine Running', () => {
  expect(isTailnetReady('Running', true)).toBeTrue();
});

test('#isTailnetReady is not ready without a key', () => {
  expect(isTailnetReady('Running', false)).toBeFalse();
});

test('#isTailnetReady is not ready while this machine is logged out', () => {
  expect(isTailnetReady('NeedsLogin', true)).toBeFalse();
});

test('#isTailnetReady is not ready without a tailscale status', () => {
  expect(isTailnetReady(null, true)).toBeFalse();
});

test('#requireTailnetReady passes with a key and this machine Running', () => {
  expect(() => {
    requireTailnetReady('Running', true);
  }).not.toThrow();
});

test('#requireTailnetReady fails with what the suite lacks while this machine is logged out', () => {
  expect(() => {
    requireTailnetReady('NeedsLogin', true);
  }).toThrowWithMessage(
    Error,
    'tailscale needs the tag:imp-e2e OAuth client (op://imp-e2e/imp-e2e-tailscale-oauth) and this machine on the tailnet',
  );
});

test('#parseSelfTags reads the tags the node joined with', () => {
  const stdout = JSON.stringify({
    BackendState: 'Running',
    Self: { HostName: 'imp', Tags: ['tag:imp-e2e'] },
  });

  expect(parseSelfTags(stdout)).toStrictEqual(['tag:imp-e2e']);
});

test('#parseSelfTags reads a node without tags as none', () => {
  expect(parseSelfTags(JSON.stringify({ Self: { HostName: 'imp' } }))).toStrictEqual([]);
});

test('#parseTailscaleStatus reads the backend state and the peers', () => {
  const stdout = JSON.stringify({
    BackendState: 'Running',
    Version: '1.102.3',
    Peer: {
      'nodekey:a': {
        DNSName: 'imp.tail1234.ts.net.',
        TailscaleIPs: ['100.64.0.7'],
        Online: true,
        Tags: ['tag:imp-e2e'],
      },
    },
  });

  expect(parseTailscaleStatus(stdout)).toStrictEqual({
    BackendState: 'Running',
    Peer: {
      'nodekey:a': {
        DNSName: 'imp.tail1234.ts.net.',
        TailscaleIPs: ['100.64.0.7'],
        Online: true,
        Tags: ['tag:imp-e2e'],
      },
    },
  });
});

test('#parseTailscaleStatus reads a status without peers as none', () => {
  expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin' }))).toStrictEqual({
    BackendState: 'NeedsLogin',
    Peer: {},
  });
});

test('#parseTailscaleStatus gives null for output that is not JSON', () => {
  expect(parseTailscaleStatus('tailscale: command not found')).toBeNull();
});

test('#parseTailscaleStatus gives null for JSON without a backend state', () => {
  expect(parseTailscaleStatus(JSON.stringify({ Peer: {} }))).toBeNull();
});

test('#findTailnetNode names the online peer that holds the IP', () => {
  const peers = [
    { DNSName: 'imp.tail1234.ts.net.', TailscaleIPs: ['100.64.0.2'], Online: false },
    {
      DNSName: 'imp-1.tail1234.ts.net.',
      TailscaleIPs: ['100.64.0.7', 'fd7a:115c:a1e0::7'],
      Online: true,
    },
  ];

  expect(findTailnetNode(peers, '100.64.0.7')).toStrictEqual({
    fqdn: 'imp-1.tail1234.ts.net',
    short: 'imp-1',
    tags: [],
  });
});

test('#findTailnetNode gives the tags the node joined with', () => {
  const peers = [
    {
      DNSName: 'imp.tail1234.ts.net.',
      TailscaleIPs: ['100.64.0.7'],
      Online: true,
      Tags: ['tag:imp-e2e'],
    },
  ];

  expect(findTailnetNode(peers, '100.64.0.7')).toStrictEqual({
    fqdn: 'imp.tail1234.ts.net',
    short: 'imp',
    tags: ['tag:imp-e2e'],
  });
});

test('#findTailnetNode passes over an offline peer that holds the IP', () => {
  const peers = [{ DNSName: 'imp.tail1234.ts.net.', TailscaleIPs: ['100.64.0.7'], Online: false }];

  expect(findTailnetNode(peers, '100.64.0.7')).toBeNull();
});

test('#findTailnetNode gives null for a peer without a MagicDNS name', () => {
  const peers = [{ DNSName: '', TailscaleIPs: ['100.64.0.7'], Online: true }];

  expect(findTailnetNode(peers, '100.64.0.7')).toBeNull();
});
