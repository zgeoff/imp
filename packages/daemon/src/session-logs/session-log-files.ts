import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { SessionLog, SessionLogRead } from '@imp/api';
import { SESSION_LOG_READ_MAX_BYTES } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { writeFileDurably } from '../storage/write-file-durably';
import {
  countLogBytes,
  findSegmentPath,
  readGenerationBounds,
  readGenerationMeta,
} from './generation-log';
import type { GenerationMeta } from './generation-log';
import { planLogRead } from './plan-log-read';

// Reading an imp's session logs: what a list, a read and a delete see.

export interface SessionLogReadRequest {
  readonly session: string;
  readonly executionGeneration: string;
  readonly from: number;
  readonly limit?: number | undefined;
}

// a live log's meta as its writer holds it, or null to read the file
export type LiveMetaReader = (generation: string) => GenerationMeta | null;

const GENERATION_PATTERN = /^[0-9a-f]{32}$/;
const TOMBSTONES = '.deleted';

function isGenerationName(name: string): boolean {
  return GENERATION_PATTERN.test(name);
}

// The directory of one generation's log. The generation came from the
// guest, so it is checked here too: nothing but a child of the imp's
// session-logs directory is ever a log.
export function findGenerationDir(sessionLogsDir: string, generation: string): string {
  const root = resolve(sessionLogsDir);
  const dir = resolve(root, generation);

  if (!isGenerationName(generation) || dirname(dir) !== root) {
    throw new Error(`session log: ${JSON.stringify(generation)} is not a generation`);
  }

  return dir;
}

// every log of the imp, live ones as their writers hold them
export function readImpMetas(sessionLogsDir: string, readLive: LiveMetaReader): GenerationMeta[] {
  if (!existsSync(sessionLogsDir)) {
    return [];
  }

  return readdirSync(sessionLogsDir)
    .filter((entry) => isGenerationName(entry))
    .flatMap((generation) => {
      const meta =
        readLive(generation) ?? readGenerationMeta(findGenerationDir(sessionLogsDir, generation));

      // a meta that names another generation is not this directory's
      return meta?.executionGeneration === generation ? [meta] : [];
    });
}

// A deleted live generation leaves a tombstone, `.deleted/<generation>`, so
// no impd taps it again; it goes once the generation is gone.
function findTombstonePath(sessionLogsDir: string, generation: string): string {
  // the same check as a log's directory, one level down
  const name = basename(findGenerationDir(sessionLogsDir, generation));

  return join(sessionLogsDir, TOMBSTONES, name);
}

export function writeTombstone(sessionLogsDir: string, generation: string): void {
  const path = findTombstonePath(sessionLogsDir, generation);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileDurably(path, '');
}

export function hasTombstone(sessionLogsDir: string, generation: string): boolean {
  return isGenerationName(generation) && existsSync(findTombstonePath(sessionLogsDir, generation));
}

export function listTombstones(sessionLogsDir: string): string[] {
  const dir = join(sessionLogsDir, TOMBSTONES);

  return existsSync(dir) ? readdirSync(dir).filter((entry) => isGenerationName(entry)) : [];
}

export function removeTombstone(sessionLogsDir: string, generation: string): void {
  rmSync(findTombstonePath(sessionLogsDir, generation), { force: true });
}

// what a destroy removed, if a log made it again: each only when empty
export function removeEmptyDirs(sessionLogsDir: string): void {
  for (const dir of [sessionLogsDir, dirname(sessionLogsDir)]) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
  }
}

export function removeGenerationDir(sessionLogsDir: string, generation: string): void {
  rmSync(findGenerationDir(sessionLogsDir, generation), { recursive: true, force: true });
}

export function toApiSessionLog(meta: GenerationMeta): SessionLog {
  const bounds = readGenerationBounds(meta);
  const bytes = countLogBytes(meta);

  // every byte of a generation that ended with an exit impd saw
  const isComplete =
    meta.state === 'ended' && meta.end !== undefined && bounds.logStart === 0 && bytes === meta.end;

  return {
    session: meta.session,
    executionGeneration: meta.executionGeneration,
    bootId: meta.bootId,
    state: meta.state,
    logStart: bounds.logStart,
    logEnd: bounds.logEnd,
    bytes,
    ...(meta.end !== undefined && { end: meta.end }),
    ...(meta.exitCode !== undefined && { exitCode: meta.exitCode }),
    complete: isComplete,
    ...(meta.stopped !== undefined && { stopped: meta.stopped }),
    startedAt: new Date(meta.startedAt),
    ...(meta.endedAt !== undefined && { endedAt: new Date(meta.endedAt) }),
  };
}

function findMeta(
  sessionLogsDir: string,
  readLive: LiveMetaReader,
  request: SessionLogReadRequest,
): GenerationMeta {
  const generation = request.executionGeneration;

  const fromFile = GENERATION_PATTERN.test(generation)
    ? readGenerationMeta(findGenerationDir(sessionLogsDir, generation))
    : null;

  const meta = readLive(generation) ?? fromFile;

  if (meta?.session !== request.session) {
    throw new ORPCError('NOT_FOUND', {
      message: `no log of session ${request.session} generation ${generation}`,
      data: { kind: 'session', name: request.session },
    });
  }

  return meta;
}

async function readSegmentBytes(path: string, skip: number, length: number): Promise<Uint8Array> {
  const data = new Uint8Array(length);

  const file = await open(path, 'r');

  try {
    const result = await file.read(data, 0, length, skip);

    if (result.bytesRead !== length) {
      throw new Error(`session log: read ${String(result.bytesRead)} of ${String(length)} bytes`);
    }
  } finally {
    await file.close();
  }

  return data;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

// A byte range with the ring's rules: a gap for lost bytes, INVALID_RESUME
// past the end. A segment removed between plan and read is planned again
// once, and then reads as a gap.
export async function readSessionLogRange(
  sessionLogsDir: string,
  readLive: LiveMetaReader,
  request: SessionLogReadRequest,
): Promise<SessionLogRead> {
  try {
    return await readRangeOnce(sessionLogsDir, readLive, request);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }

    return readRangeOnce(sessionLogsDir, readLive, request);
  }
}

async function readRangeOnce(
  sessionLogsDir: string,
  readLive: LiveMetaReader,
  request: SessionLogReadRequest,
): Promise<SessionLogRead> {
  const meta = findMeta(sessionLogsDir, readLive, request);
  const limit = Math.min(request.limit ?? SESSION_LOG_READ_MAX_BYTES, SESSION_LOG_READ_MAX_BYTES);
  const plan = planLogRead(meta.segments, meta.origin, request.from, limit);

  if (plan.kind === 'past_end') {
    throw new ORPCError('INVALID_RESUME', {
      message: `offset ${String(request.from)} is past the end of the log, ${String(plan.logEnd)}`,
      data: { end: plan.logEnd, bufferStart: plan.logStart },
    });
  }

  const dir = findGenerationDir(sessionLogsDir, meta.executionGeneration);

  const data =
    plan.segment === null || plan.length === 0
      ? new Uint8Array(0)
      : await readSegmentBytes(findSegmentPath(dir, plan.segment.start), plan.skip, plan.length);

  return {
    offset: plan.offset,
    ...(plan.gap !== null && { gap: plan.gap }),
    data: new Blob([data], { type: 'application/octet-stream' }),
    log: toApiSessionLog(meta),
  };
}
