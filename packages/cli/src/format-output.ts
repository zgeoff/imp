import type {
  ApiCall,
  AuditEntry,
  BackupRun,
  BackupStatus,
  Checkpoint,
  Identity,
  Image,
  Imp,
  Secret,
  Session,
  SshKey,
  StorageGc,
  SystemInfo,
  Token,
} from '@imp/api';

type Row = readonly string[];

export function formatTable(header: Row, rows: readonly Row[]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );

  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function formatImps(imps: readonly Imp[]): string {
  return formatTable(
    [
      'NAME',
      'STATE',
      'IMAGE',
      'VCPUS',
      'MEMORY',
      'RAM',
      'DISK',
      'USED',
      'SHARED',
      'SESSIONS',
      'IP',
      'URL',
      'NOTE',
    ],
    imps.map((imp) => [
      imp.name,
      imp.state,
      imp.image,
      String(imp.vcpus),
      `${String(imp.memoryMib)} MiB`,
      imp.ramMib === undefined ? '-' : `${String(imp.ramMib)} MiB`,
      formatDiskMib(imp.diskMib),
      ...formatDiskUsage(imp.diskUsage),
      imp.sessions === undefined ? '-' : String(imp.sessions),
      imp.ip,
      imp.url,
      formatNote(imp),
    ]),
  );
}

// what a destroy frees, and what the imp shares; `<=` when a fork holds a
// snapshot of it, `?` when the last pass was cut short
function formatDiskUsage(usage: Imp['diskUsage']): [string, string] {
  if (usage === undefined) {
    return ['-', '-'];
  }

  const bound = usage.isUpperBound ? '<=' : '';
  const partial = usage.isPartial ? '?' : '';

  return [
    `${bound}${formatBytesMib(usage.exclusiveBytes)}${partial}`,
    `${formatBytesMib(usage.sharedBytes)}${partial}`,
  ];
}

function formatBytesMib(bytes: number): string {
  return `${String(Math.round(bytes / 1_048_576))} MiB`;
}

// GiB when whole, as sizes are given
function formatDiskMib(mib: number): string {
  return mib % 1024 === 0 ? `${String(mib / 1024)} GiB` : `${String(mib)} MiB`;
}

// what an upgrade means for the imp (docs/guides/operations.md#upgrade)
function formatNote(imp: Imp): string {
  const notes: string[] = [];

  if (imp.coldBootReason !== undefined) {
    const when = imp.state === 'sleeping' ? 'boots cold' : 'booted cold';

    notes.push(`${when}: ${imp.coldBootReason}`);
  }

  const outdated = imp.outdated ?? [];
  const parts = outdated.filter((part) => part !== 'impd');

  if (outdated.includes('impd')) {
    notes.push('booted by an older impd; its next wake boots cold');
  }

  if (parts.length > 0) {
    notes.push(`outdated: ${parts.join(', ')}`);
  }

  return notes.join('; ');
}

export function formatImp(imp: Imp): string {
  return formatImps([imp]);
}

export function formatCheckpoints(checkpoints: readonly Checkpoint[]): string {
  return formatTable(
    ['ID', 'LABEL', 'CREATED', 'SIZE', 'DISK'],
    checkpoints.map((checkpoint) => [
      checkpoint.id,
      checkpoint.label ?? '',
      checkpoint.createdAt.toISOString(),
      checkpoint.sizeBytes === undefined
        ? ''
        : `${String(Math.round(checkpoint.sizeBytes / 1_048_576))} MiB`,
      formatDiskMib(checkpoint.diskMib),
    ]),
  );
}

export function formatBackupStatus(status: Readonly<BackupStatus>): string {
  const table = formatTable(
    ['ID', 'TIME (UTC)', 'IMPS'],
    status.points.map((point) => [
      point.id.slice(0, 8),
      point.time.toISOString(),
      point.imps.join(' '),
    ]),
  );

  const check =
    status.lastCheck === null
      ? 'never'
      : `${status.lastCheck.at.toISOString()} ${status.lastCheck.error === undefined ? 'ok' : `FAILED: ${status.lastCheck.error}`}`;

  return [
    table,
    '',
    `last run:   ${status.lastRunAt?.toISOString() ?? 'never'}`,
    `last prune: ${status.lastPruneAt?.toISOString() ?? 'never'}`,
    `last check: ${check}`,
  ].join('\n');
}

// what `imp info` says an upgrade left: the imps whose next wake boots
// cold, and how many run each older part; an older impd does not count them
export function formatBootStatus(
  status: Readonly<SystemInfo['bootStatus']> | undefined,
  impdVersion: string,
): string {
  if (status === undefined) {
    return `unknown (impd ${impdVersion} predates it)`;
  }

  const notes: string[] = [];

  if (status.coldBoots > 0) {
    notes.push(`${String(status.coldBoots)} will boot cold`);
  }

  const outdated = Object.entries(status.outdated)
    .filter(([, count]) => count > 0)
    .map(([part, count]) => `${String(count)} ${part}`);

  if (outdated.length > 0) {
    notes.push(`outdated: ${outdated.join(', ')}`);
  }

  return notes.length === 0 ? 'none' : notes.join('; ');
}

export function formatBackupRun(run: Readonly<BackupRun>): string {
  const lines = [
    `backup ${run.snapshotId.slice(0, 8)}: ${String(run.imps.length)} imps, ${String(Math.round(run.dataAddedBytes / 1_048_576))} MiB added in ${String(Math.round(run.durationMs / 1000))}s`,
    ...run.skipped.map((skip) => `left out ${skip.name}: ${skip.reason}`),
  ];

  return lines.join('\n');
}

export function formatSessions(sessions: readonly Readonly<Session>[]): string {
  return formatTable(
    ['NAME', 'STATE', 'ATTACHED', 'PID', 'SIZE', 'STARTED', 'COMMAND'],
    sessions.map((session) => [
      session.name,
      formatSessionState(session),
      session.attached ? 'yes' : 'no',
      String(session.pid),
      `${String(session.cols)}x${String(session.rows)}`,
      session.startedAt.toISOString(),
      session.argv.join(' '),
    ]),
  );
}

function formatSessionState(session: Readonly<Session>): string {
  if (session.exit === undefined) {
    return session.state;
  }

  const how = session.exit.signal ?? `code ${String(session.exit.code)}`;

  return `exited (${how})`;
}

export function formatImages(images: readonly Image[]): string {
  return formatTable(
    ['NAME', 'REF', 'DIGEST', 'SIZE'],
    images.map((image) => [
      image.name,
      image.ref,
      image.digest.slice(0, 19),
      `${String(Math.round(image.sizeBytes / 1_048_576))} MiB`,
    ]),
  );
}

export function formatSecrets(secrets: readonly Secret[]): string {
  return formatTable(
    ['NAME', 'KIND', 'HOSTS', 'IMPS'],
    secrets.map((secret) => [
      secret.name,
      secret.kind,
      secret.rules.map((rule) => rule.host).join(','),
      secret.imps.length === 0 ? '-' : secret.imps.join(','),
    ]),
  );
}

export function formatTokens(tokens: readonly Token[]): string {
  return formatTable(
    ['NAME', 'SCOPE', 'IMPS', 'SSH KEYS', 'CREATED'],
    tokens.map((token) => [
      token.name,
      token.scope,
      token.imps === null ? '*' : token.imps.join(','),
      String(token.sshKeys.length),
      token.createdAt.toISOString(),
    ]),
  );
}

// `SHA256:... comment`, as `ssh-keygen -l` prints a key
export function formatSshKey(key: SshKey): string {
  return key.comment === '' ? key.fingerprint : `${key.fingerprint} ${key.comment}`;
}

export function formatIdentity(identity: Identity): string {
  const imps = identity.imps === null ? 'every imp' : identity.imps.join(',');

  return `${identity.kind} ${identity.name}: ${identity.scope} on ${imps}`;
}

export function formatAudit(entries: readonly AuditEntry[]): string {
  return formatTable(
    ['TIME', 'IMP', 'SECRET', 'METHOD', 'HOST', 'PATH', 'STATUS', 'BYTES', 'MS'],
    entries.map((entry) => [
      entry.at.toISOString(),
      entry.imp,
      entry.secret,
      entry.method,
      entry.host,
      entry.path,
      String(entry.status),
      `${String(entry.requestBytes)}/${String(entry.responseBytes)}`,
      String(entry.durationMs),
    ]),
  );
}

export function formatApiCalls(calls: readonly ApiCall[]): string {
  return formatTable(
    ['TIME', 'IMP', 'PROCEDURE', 'ACTOR', 'OUTCOME', 'MS'],
    calls.map((call) => [
      call.at.toISOString(),
      call.imp ?? '-',
      call.procedure,
      call.actorName === undefined ? call.actor : `${call.actor} ${call.actorName}`,
      call.outcome,
      String(call.durationMs),
    ]),
  );
}

export function formatGc(gc: Readonly<StorageGc>): string {
  if (gc.dropped.length === 0) {
    return 'nothing to remove';
  }

  const table = formatTable(
    ['KIND', 'ID'],
    gc.dropped.map((dropped) => [dropped.kind, dropped.id]),
  );

  return gc.dryRun ? `${table}\n(dry run: nothing removed)` : table;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// what a command prints: JSON with --json, else its table
export function formatOutput<T>(
  value: T,
  json: boolean | undefined,
  formatText: (value: T) => string,
): string {
  return json === true ? formatJson(value) : formatText(value);
}
