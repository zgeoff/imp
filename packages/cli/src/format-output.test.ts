import { expect, test } from 'bun:test';
import type { Imp } from '@imp/api';
import {
  formatBootStatus,
  formatCheckpoints,
  formatImps,
  formatSessions,
  formatTable,
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

test('it lists checkpoints with their size in MiB', () => {
  const table = formatCheckpoints([
    { id: 'cp-a2b3c4', label: 'clean', createdAt: new Date(0), sizeBytes: 3_145_728 },
    { id: 'cp-d5e6f7', createdAt: new Date(0) },
  ]);

  expect(table.split('\n')).toEqual([
    'ID         LABEL  CREATED                   SIZE',
    'cp-a2b3c4  clean  1970-01-01T00:00:00.000Z  3 MiB',
    'cp-d5e6f7         1970-01-01T00:00:00.000Z',
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
  ]).split('\n');

  const notes = rows.map((row) => row.slice(rows[0]?.indexOf('NOTE')));

  expect(notes).toEqual([
    'NOTE',
    'boots cold: firecrackerVersion changed (v1.17.0 → v1.18.0)',
    'booted cold: wake failed; outdated: agent',
    'outdated: kernel, agent',
    'booted by an older impd; its next wake boots cold',
  ]);
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
  const none = formatBootStatus({
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 0, agent: 0 },
  });

  const some = formatBootStatus({
    coldBoots: 3,
    outdated: { firecracker: 1, kernel: 0, agent: 2 },
  });

  const outdatedOnly = formatBootStatus({
    coldBoots: 0,
    outdated: { firecracker: 0, kernel: 1, agent: 0 },
  });

  expect(none).toBe('none');
  expect(some).toBe('3 will boot cold; outdated: 1 firecracker, 2 agent');
  expect(outdatedOnly).toBe('outdated: 1 kernel');
});
