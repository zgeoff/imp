import type {
  ApiCall,
  AuditEntry,
  BackupRun,
  BackupStatus,
  Checkpoint,
  ExposeResult,
  Identity,
  Image,
  Imp,
  Network,
  OAuthApproval,
  OAuthClient,
  OAuthGrant,
  OrphanStorage,
  Secret,
  Service,
  Session,
  SessionLog,
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

const IMP_HEADER = [
  'NAME',
  'STATE',
  'IMAGE',
  'VCPUS',
  'MEMORY',
  'RAM',
  'DISK',
  'USED',
  'SHARED',
  'CPU',
  'SESSIONS',
  'IP',
  'URL',
  'NOTE',
] as const;

export function formatImps(imps: readonly Imp[]): string {
  return formatTable(
    IMP_HEADER,
    imps.map((imp) => toImpRow(imp)),
  );
}

// `imp ls --all`: the saved host first, then the columns of `imp ls`
export function formatHostImps(imps: readonly (Imp & { readonly host: string })[]): string {
  return formatTable(
    ['HOST', ...IMP_HEADER],
    imps.map((imp) => [imp.host, ...toImpRow(imp)]),
  );
}

function toImpRow(imp: Imp): Row {
  return [
    imp.name,
    imp.state,
    imp.image,
    String(imp.vcpus),
    formatMemory(imp),
    imp.ramMib === undefined ? '-' : `${String(imp.ramMib)} MiB`,
    formatDiskMib(imp.diskMib),
    ...formatDiskUsage(imp.diskUsage),
    formatCpuUse(imp),
    imp.sessions === undefined ? '-' : String(imp.sessions),
    imp.ip,
    imp.url,
    formatNote(imp),
  ];
}

// an elastic imp's size now and its max: `768/1024 MiB`
function formatMemory(imp: Imp): string {
  if (imp.maxMemoryMib === undefined) {
    return `${String(imp.memoryMib)} MiB`;
  }

  const nowMib = imp.memoryMib + (imp.pluggedMib ?? 0);

  return `${String(nowMib)}/${String(imp.maxMemoryMib)} MiB`;
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

// what the imp's storage takes over its disk size, as `imp top` shows it:
// `<=1203 MiB / 32 GiB`
export function formatDiskUse(imp: Imp): string {
  const [used] = formatDiskUsage(imp.diskUsage);

  return `${used} / ${formatDiskMib(imp.diskMib)}`;
}

// the last sample's CPU, in percent of one core, over the limit when there is
// one: `45% / 1.5`
export function formatCpuUse(imp: Imp): string {
  const percent = imp.resources?.sample?.cpuPercent;
  const used = percent === undefined ? '-' : `${percent.toFixed(0)}%`;
  const limit = imp.cpu?.limit ?? null;

  return limit === null ? used : `${used} / ${String(limit)}`;
}

// what an upgrade means for the imp (docs/guides/operations.md#upgrade), and
// an agent the watchdog reports silent
function formatNote(imp: Imp): string {
  const notes: string[] = [];

  // first: during a move the imp shows on both hosts, and this says which
  // side each row is (docs/guides/hosts.md#one-view)
  if (imp.move !== undefined) {
    notes.push(imp.move);
  }

  // impd's, for one image build (docs/guides/images.md#isolated-builds)
  if (imp.kind === 'builder') {
    notes.push('image builder');
  }

  if (imp.agentSilentSince !== undefined) {
    notes.push(`agent silent since ${imp.agentSilentSince.toISOString()}`);
  }

  if (imp.public !== undefined) {
    const auth = imp.public.auth === 'none' ? '' : ` (${imp.public.auth})`;

    notes.push(`public${auth}`);
  }

  if (imp.coldBootReason !== undefined) {
    const when = imp.state === 'sleeping' ? 'boots cold' : 'booted cold';

    notes.push(`${when}: ${imp.coldBootReason}`);
  }

  const outdated = imp.outdated ?? [];
  const parts = outdated.filter((part) => part !== 'impd' && part !== 'ipv6');

  if (outdated.includes('impd')) {
    notes.push('booted by an older impd; its next wake boots cold');
  }

  if (parts.length > 0) {
    notes.push(`outdated: ${parts.join(', ')}`);
  }

  if (outdated.includes('ipv6')) {
    notes.push('no IPv6 until its next cold boot');
  }

  return notes.join('; ');
}

// What an expose made, the credential included: impd shows it this once
export function formatExposeResult(result: ExposeResult): string {
  const lines = [`${result.url} is public`];

  if (result.auth === 'token') {
    lines.push(`token: ${result.credential ?? ''}`);
  }

  if (result.auth === 'basic') {
    lines.push(`user: ${result.user ?? ''}`, `password: ${result.credential ?? ''}`);
  }

  if (result.credential !== null) {
    lines.push('impd keeps only a hash; expose the imp again for a new one.');
  }

  if (result.warning !== undefined) {
    lines.push(`warning: ${result.warning}`);
  }

  return lines.join('\n');
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

// `imp info`'s https line: the domain, and whether the DNS API token file
// reads now. A token from the env has no check, and says nothing: only the
// provider can tell whether a token is good. No line from an impd before it.
export function formatHttps(info: SystemInfo['https']): string[][] {
  if (info === undefined) {
    return [];
  }

  if (info === null) {
    return [['https', 'off (IMP_DOMAIN unset)']];
  }

  const token = info.dnsToken;

  if (token === null) {
    return [['https', info.domain]];
  }

  const state = token.isOk
    ? 'DNS token file readable'
    : `ERROR: ${token.error ?? 'the DNS token file fails'}`;

  return [['https', `${info.domain}, ${state}`]];
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

  const { ipv6 = 0, ...parts } = status.outdated;

  const outdated = Object.entries(parts)
    .filter(([, count]) => count > 0)
    .map(([part, count]) => `${String(count)} ${part}`);

  if (outdated.length > 0) {
    notes.push(`outdated: ${outdated.join(', ')}`);
  }

  if (ipv6 > 0) {
    notes.push(`${String(ipv6)} with no IPv6 until a cold boot`);
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

export function formatSessionLogs(logs: readonly SessionLog[]): string {
  return formatTable(
    ['SESSION', 'GENERATION', 'STATE', 'BYTES', 'OFFSETS', 'EXIT', 'STARTED'],
    logs.map((log) => [
      log.session,
      log.executionGeneration,
      formatLogState(log),
      String(log.bytes),
      `${String(log.logStart)}-${String(log.logEnd)}`,
      formatLogExit(log),
      log.startedAt.toISOString(),
    ]),
  );
}

function formatLogState(log: SessionLog): string {
  if (log.stopped !== undefined) {
    return `${log.state} (stopped: ${log.stopped})`;
  }

  return log.complete ? `${log.state} (complete)` : log.state;
}

function formatLogExit(log: SessionLog): string {
  if (log.exitCode === undefined) {
    return '-';
  }

  return log.exitCode === null ? 'signal' : String(log.exitCode);
}

function formatSessionState(session: Readonly<Session>): string {
  if (session.exit === undefined) {
    return session.state;
  }

  const how = session.exit.signal ?? `code ${String(session.exit.code)}`;

  return `exited (${how})`;
}

export function formatServices(services: readonly Readonly<Service>[]): string {
  return formatTable(
    ['NAME', 'STATE', 'PID', 'RESTARTS', 'LAST EXIT', 'COMMAND'],
    services.map((service) => [
      service.name,
      service.state,
      service.pid === null ? '-' : String(service.pid),
      String(service.restarts),
      formatLastExit(service.lastExit),
      service.argv.join(' '),
    ]),
  );
}

function formatLastExit(exit: Service['lastExit']): string {
  if (exit === null) {
    return '-';
  }

  return exit.signal ?? `code ${String(exit.code)}`;
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
    ['NAME', 'KIND', 'STATE', 'HOSTS', 'IMPS'],
    secrets.map((secret) => [
      secret.name,
      secret.kind,
      formatSecretState(secret),
      secret.rules
        .map((rule) =>
          rule.upstream === undefined ? rule.host : `${rule.host} -> ${rule.upstream}`,
        )
        .join(','),
      secret.imps.length === 0 ? '-' : secret.imps.join(','),
    ]),
  );
}

// `-` for a kind that never expires; for oauth, whether its access token is
// there and until when
function formatSecretState(secret: Readonly<Secret>): string {
  const oauth = secret.oauth;

  if (oauth === undefined) {
    return '-';
  }

  if (oauth.status === 'ready') {
    return oauth.expiresAt === null ? 'ready' : `ready until ${oauth.expiresAt.toISOString()}`;
  }

  if (oauth.status === 'pending') {
    return oauth.error === null ? 'pending' : `pending (${oauth.error})`;
  }

  return `needs_login (${oauth.error ?? 'unknown'})`;
}

export function formatNetworks(networks: readonly Network[]): string {
  return formatTable(
    ['NAME', 'IMPS'],
    networks.map((network) => [
      network.name,
      network.imps.length === 0 ? '-' : network.imps.join(','),
    ]),
  );
}

// a token or an identity as any impd answers: one from before grantable
// lists leaves the field out, and the client applies no schema default
type WithOptionalGrantable<T> = Omit<T, 'grantable'> & {
  readonly grantable?: readonly string[] | undefined;
};

export function formatTokens(tokens: readonly WithOptionalGrantable<Token>[]): string {
  return formatTable(
    ['NAME', 'SCOPE', 'IMPS', 'GRANTABLE', 'SSH KEYS', 'CREATED'],
    tokens.map((token) => [
      token.name,
      token.scope,
      token.imps === null ? '*' : token.imps.join(','),
      formatGrantable(token, '-'),
      String(token.sshKeys.length),
      token.createdAt.toISOString(),
    ]),
  );
}

export function formatOAuthClients(clients: readonly OAuthClient[]): string {
  return formatTable(
    ['NAME', 'CLIENT ID', 'REDIRECT URIS', 'CREATED'],
    clients.map((client) => [
      client.name,
      client.clientId,
      client.redirectUris.join(','),
      client.createdAt.toISOString(),
    ]),
  );
}

export function formatOAuthGrants(grants: readonly OAuthGrant[]): string {
  return formatTable(
    ['ID', 'CLIENT', 'TOKEN', 'SCOPE', 'IMPS', 'CREATED', 'LAST USED'],
    grants.map((grant) => [
      grant.id,
      grant.client,
      grant.token,
      grant.scope,
      grant.imps === null ? '*' : grant.imps.join(','),
      grant.createdAt.toISOString(),
      grant.lastUsedAt?.toISOString() ?? '-',
    ]),
  );
}

// what a sign-in asks for, for its approver to check before approving
export function formatOAuthApproval(approval: Readonly<OAuthApproval>): string {
  return [
    `client:       ${approval.client}`,
    `returns to:   ${approval.redirectUri}`,
    `asks for:     up to ${approval.requestedScope}`,
    `started:      ${approval.requestedAt.toISOString()}`,
    `ends:         ${approval.expiresAt.toISOString()}`,
  ].join('\n');
}

// `SHA256:... comment`, as `ssh-keygen -l` prints a key
export function formatSshKey(key: SshKey): string {
  return key.comment === '' ? key.fingerprint : `${key.fingerprint} ${key.comment}`;
}

export function formatIdentity(identity: WithOptionalGrantable<Identity>): string {
  const imps = identity.imps === null ? 'every imp' : identity.imps.join(',');
  const names = formatGrantable(identity, '');
  const grants = names === '' ? '' : `; may grant ${names}`;

  return `${identity.kind} ${identity.name}: ${identity.scope} on ${imps}${grants}`;
}

// the secrets it may grant, comma-separated, or `none`
function formatGrantable(
  entry: Readonly<{ grantable?: readonly string[] | undefined }>,
  none: string,
): string {
  const names = entry.grantable ?? [];

  return names.length === 0 ? none : names.join(',');
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
    ['TIME', 'IMP', 'PROCEDURE', 'ACTOR', 'OUTCOME', 'MS', 'DETAIL'],
    calls.map((call) => [
      call.at.toISOString(),
      call.imp ?? '-',
      call.procedure,
      call.actorName === undefined ? call.actor : `${call.actor} ${call.actorName}`,
      call.outcome,
      String(call.durationMs),
      call.detail ?? '-',
    ]),
  );
}

// what went, or would go, then the orphans it kept
export function formatGc(gc: Readonly<StorageGc>): string {
  const kept = gc.kept ?? [];

  const removed =
    gc.dropped.length === 0
      ? 'nothing to remove'
      : formatTable(
          ['KIND', 'ID'],
          gc.dropped.map((dropped) => [dropped.kind, dropped.id]),
        );

  const lines = [
    gc.dryRun && gc.dropped.length > 0 ? `${removed}\n(dry run: nothing removed)` : removed,
  ];

  if (kept.length > 0) {
    lines.push(
      `\nkept ${String(kept.length)} orphans the database does not name; \`imp gc --orphans\` retires them:`,
      formatTable(
        ['KIND', 'ID', 'LOCATION', 'SIZE', 'CREATED', 'SNAPSHOTS'],
        kept.map((orphan) => [
          orphan.kind,
          orphan.id,
          orphan.location,
          formatBytesMib(orphan.bytes),
          orphan.createdAt?.toISOString() ?? '-',
          formatOrphanContents(orphan),
        ]),
      ),
    );
  }

  return lines.join('\n');
}

// its snapshots, or for kept secret values how many files
function formatOrphanContents(orphan: Readonly<OrphanStorage>): string {
  if (orphan.files !== undefined) {
    return `${String(orphan.files.length)} files`;
  }

  return orphan.snapshots.length === 0 ? '-' : orphan.snapshots.join(',');
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
