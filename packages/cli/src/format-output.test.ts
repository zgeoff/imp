import { expect, test } from 'bun:test';
import type { Imp } from '@imp/api';
import {
  formatApiCalls,
  formatBootStatus,
  formatCheckpoints,
  formatExposeResult,
  formatGc,
  formatIdentity,
  formatImps,
  formatSessions,
  formatSshKey,
  formatTable,
  formatTokens,
} from './format-output';

test('it pads each column to its widest cell', () => {
  const table = formatTable(
    ['NAME', 'STATE'],
    [
      ['dev', 'running'],
      ['scratchpad', 'sleeping'],
    ],
  );

  expect(table).toBe(
    ['NAME        STATE', 'dev         running', 'scratchpad  sleeping'].join('\n'),
  );
});

test('it lists checkpoints with their size in MiB and their disk size', () => {
  const table = formatCheckpoints([
    {
      id: 'cp-a2b3c4',
      label: 'clean',
      createdAt: new Date(0),
      sizeBytes: 3_145_728,
      diskMib: 32_768,
    },
    { id: 'cp-d5e6f7', createdAt: new Date(0), diskMib: 65_536 + 512 },
  ]);

  expect(table.split('\n')).toEqual([
    'ID         LABEL  CREATED                   SIZE   DISK',
    'cp-a2b3c4  clean  1970-01-01T00:00:00.000Z  3 MiB  32 GiB',
    'cp-d5e6f7         1970-01-01T00:00:00.000Z         66048 MiB',
  ]);
});

test('it notes why an imp boots cold and what it predates', () => {
  const imp: Imp = {
    id: 'i1',
    name: 'dev',
    image: 'ubuntu',
    state: 'sleeping',
    vcpus: 2,
    memoryMib: 512,
    diskMib: 32_768,
    ip: '10.0.0.2',
    slot: 0,
    port: 7100,
    httpPort: 8080,
    url: 'http://dev.imp.localhost:7080',
    createdAt: new Date(0),
    lastActiveAt: new Date(0),
  };

  const rows = formatImps([
    { ...imp, coldBootReason: 'firecrackerVersion changed (v1.17.0 → v1.18.0)' },
    { ...imp, name: 'web', state: 'running', coldBootReason: 'wake failed', outdated: ['agent'] },
    { ...imp, name: 'db', outdated: ['kernel', 'agent'] },
    { ...imp, name: 'old', state: 'running', outdated: ['impd'] },
    { ...imp, name: 'deaf', state: 'running', agentSilentSince: new Date(60_000) },
    { ...imp, name: 'pub', public: { auth: 'token' } },
    { ...imp, name: 'open', public: { auth: 'none' } },
    { ...imp, name: 'v4', state: 'running', outdated: ['ipv6'] },
    { ...imp, name: 'away', state: 'stopped', move: 'moved' },
    { ...imp, name: 'here', state: 'stopped', move: 'receiving', public: { auth: 'none' } },
  ]).split('\n');

  const notes = rows.map((row) => row.slice(rows[0]?.indexOf('NOTE')));

  expect(notes).toEqual([
    'NOTE',
    'boots cold: firecrackerVersion changed (v1.17.0 → v1.18.0)',
    'booted cold: wake failed; outdated: agent',
    'outdated: kernel, agent',
    'booted by an older impd; its next wake boots cold',
    'agent silent since 1970-01-01T00:01:00.000Z',
    'public (token)',
    'public',
    'no IPv6 until its next cold boot',
    'moved',
    'receiving; public',
  ]);
});

test('an expose prints the URL and the credential it made', () => {
  const url = 'https://web.imp.example.com';

  expect(formatExposeResult({ url, auth: 'none', user: null, credential: null })).toBe(
    `${url} is public`,
  );

  expect(
    formatExposeResult({ url, auth: 'none', user: null, credential: null, warning: 'no record' }),
  ).toBe(`${url} is public\nwarning: no record`);

  expect(formatExposeResult({ url, auth: 'basic', user: 'imp', credential: 'pw' })).toBe(
    [
      `${url} is public`,
      'user: imp',
      'password: pw',
      'impd keeps only a hash; expose the imp again for a new one.',
    ].join('\n'),
  );
});

test('it lists sessions with their state, size and command', () => {
  const session = {
    name: 'main',
    pid: 301,
    argv: ['bash', '-l'],
    state: 'running',
    attached: true,
    cols: 120,
    rows: 40,
    startedAt: new Date(0),
  } as const;

  const table = formatSessions([
    session,
    {
      ...session,
      name: 'job',
      state: 'exited',
      attached: false,
      exit: { code: 3, signal: null },
    },
    {
      ...session,
      name: 'hung',
      state: 'exited',
      attached: false,
      exit: { code: null, signal: 'SIGKILL' },
    },
  ]);

  expect(table.split('\n')).toEqual([
    'NAME  STATE             ATTACHED  PID  SIZE    STARTED                   COMMAND',
    'main  running           yes       301  120x40  1970-01-01T00:00:00.000Z  bash -l',
    'job   exited (code 3)   no        301  120x40  1970-01-01T00:00:00.000Z  bash -l',
    'hung  exited (SIGKILL)  no        301  120x40  1970-01-01T00:00:00.000Z  bash -l',
  ]);
});

test('it counts sessions in the imp list, and shows - when impd has not seen them', () => {
  const imp = {
    id: 'i1',
    name: 'dev',
    image: 'ubuntu',
    state: 'running',
    vcpus: 2,
    memoryMib: 512,
    diskMib: 32_768,
    ip: '10.0.0.2',
    slot: 0,
    port: 7100,
    httpPort: 8080,
    url: 'http://dev.imp.localhost:7080',
    createdAt: new Date(0),
    lastActiveAt: new Date(0),
  } as const;

  const rows = formatImps([
    { ...imp, sessions: 2 },
    { ...imp, name: 'new' },
  ]).split('\n');

  const column = rows.map((row) => row.slice(rows[0]?.indexOf('SESSIONS')).split(/\s+/)[0]);

  expect(column).toEqual(['SESSIONS', '2', '-']);
});

test('it says how many imps will boot cold and run each older part', () => {
  const none = formatBootStatus(
    {
      coldBoots: 0,
      outdated: { firecracker: 0, kernel: 0, agent: 0 },
    },
    '0.2.0',
  );

  const some = formatBootStatus(
    {
      coldBoots: 3,
      outdated: { firecracker: 1, kernel: 0, agent: 2 },
    },
    '0.2.0',
  );

  const outdatedOnly = formatBootStatus(
    {
      coldBoots: 0,
      outdated: { firecracker: 0, kernel: 1, agent: 0 },
    },
    '0.2.0',
  );

  expect(none).toBe('none');
  expect(some).toBe('3 will boot cold; outdated: 1 firecracker, 2 agent');
  expect(outdatedOnly).toBe('outdated: 1 kernel');
});

test('it says an older impd does not report boot status', () => {
  // an impd from before the counts leaves the field out
  const status = formatBootStatus(undefined, '0.1.0');

  expect(status).toBe('unknown (impd 0.1.0 predates it)');
});

test('a gc lists what it removed, and says when a dry run removed nothing', () => {
  const dropped = [
    { kind: 'imp', id: 'lost' },
    { kind: 'checkpoint', id: 'cp-a2b3c4' },
  ] as const;

  expect(formatGc({ dryRun: false, dropped: [...dropped] }).split('\n')).toEqual([
    'KIND        ID',
    'imp         lost',
    'checkpoint  cp-a2b3c4',
  ]);

  expect(formatGc({ dryRun: true, dropped: [...dropped] })).toContain('dry run: nothing removed');
  expect(formatGc({ dryRun: false, dropped: [] })).toBe('nothing to remove');
});

test('a gc lists the orphans it kept, with their size, age and snapshots', () => {
  const kept = [
    {
      kind: 'imp',
      id: 'a',
      location: 'tank/imp/disks/a',
      bytes: 3_145_728,
      createdAt: new Date('2026-10-03T00:00:00Z'),
      snapshots: ['cp-1', 'cp-2'],
    },
    {
      kind: 'image',
      id: '9f2c',
      location: '/var/lib/imp/images/9f2c',
      bytes: 0,
      createdAt: null,
      snapshots: [],
    },
  ] as const;

  expect(formatGc({ dryRun: false, dropped: [], kept: [...kept] }).split('\n')).toEqual([
    'nothing to remove',
    '',
    'kept 2 orphans the database does not name; `imp gc --orphans` retires them:',
    'KIND   ID    LOCATION                  SIZE   CREATED                   SNAPSHOTS',
    'imp    a     tank/imp/disks/a          3 MiB  2026-10-03T00:00:00.000Z  cp-1,cp-2',
    'image  9f2c  /var/lib/imp/images/9f2c  0 MiB  -                         -',
  ]);
});

test('the imp list shows what a destroy frees and what the imp shares', () => {
  const imp = {
    id: 'i1',
    name: 'dev',
    image: 'ubuntu',
    state: 'running',
    vcpus: 2,
    memoryMib: 512,
    diskMib: 32_768,
    ip: '10.0.0.2',
    slot: 0,
    port: 7100,
    httpPort: 8080,
    url: 'http://dev.imp.localhost:7080',
    createdAt: new Date(0),
    lastActiveAt: new Date(0),
  } as const;

  const usage = {
    exclusiveBytes: 300 * 1_048_576,
    sharedBytes: 1200 * 1_048_576,
    measuredAt: new Date(0),
    isPartial: false,
    isUpperBound: false,
  };

  const rows = formatImps([
    { ...imp, diskUsage: usage },
    { ...imp, name: 'forked', diskUsage: { ...usage, isUpperBound: true, isPartial: true } },
    { ...imp, name: 'new' },
  ]).split('\n');

  const start = rows[0]?.indexOf('USED') ?? 0;

  expect(
    rows.map((row) =>
      row
        .slice(start)
        .split(/\s{2,}/)
        .slice(0, 2),
    ),
  ).toEqual([
    ['USED', 'SHARED'],
    ['300 MiB', '1200 MiB'],
    ['<=300 MiB?', '1200 MiB?'],
    ['-', '-'],
  ]);
});

const LAPTOP_KEY = { fingerprint: 'SHA256:abc', type: 'ssh-ed25519', comment: 'me@laptop' };

test('it lists tokens with their scope and imps, and * for every imp', () => {
  const createdAt = new Date('2026-10-02T00:00:00Z');

  const text = formatTokens([
    { name: 'ci', scope: 'exec', imps: ['dev-*', 'ci-*'], sshKeys: [LAPTOP_KEY], createdAt },
    { name: 'ops', scope: 'manage', imps: null, sshKeys: [], createdAt },
  ]);

  expect(text.split('\n').map((line) => line.trimEnd())).toEqual([
    'NAME  SCOPE   IMPS        SSH KEYS  CREATED',
    'ci    exec    dev-*,ci-*  1         2026-10-02T00:00:00.000Z',
    'ops   manage  *           0         2026-10-02T00:00:00.000Z',
  ]);
});

test('it prints a key as ssh-keygen -l does', () => {
  expect(formatSshKey(LAPTOP_KEY)).toBe('SHA256:abc me@laptop');
  expect(formatSshKey({ ...LAPTOP_KEY, comment: '' })).toBe('SHA256:abc');
});

test('it names the caller and what it may do, and who made each api call', () => {
  expect(
    formatIdentity({ kind: 'tailnet', name: 'me@example.com', scope: 'read', imps: null }),
  ).toBe('tailnet me@example.com: read on every imp');

  const call = { at: new Date(0), procedure: 'imps.stop', outcome: 'ok', durationMs: 3 };

  const text = formatApiCalls([
    { ...call, actor: 'token', actorName: 'ci', imp: 'dev' },
    { ...call, actor: 'dashboard' },
  ]);

  expect(text).toContain('token ci');
  expect(text.split('\n')[2]).toContain(' dashboard ');
});
