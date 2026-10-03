import { existsSync, readdirSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionLog, SessionLogRead } from '@imp/api';
import { SESSION_LOG_READ_MAX_BYTES } from '@imp/api';
import { ORPCError } from '@orpc/server';
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

export function findGenerationDir(sessionLogsDir: string, generation: string): string {
  return join(sessionLogsDir, generation);
}

// every log of the imp, live ones as their writers hold them
export function readImpMetas(sessionLogsDir: string, readLive: LiveMetaReader): GenerationMeta[] {
  if (!existsSync(sessionLogsDir)) {
    return [];
  }

  return readdirSync(sessionLogsDir).flatMap((generation) => {
    const meta =
      readLive(generation) ?? readGenerationMeta(findGenerationDir(sessionLogsDir, generation));

    return meta === null ? [] : [meta];
  });
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

// A byte range with the ring's rules: a gap for what the log lost, and
// INVALID_RESUME past its end, which never rewinds.
export async function readSessionLogRange(
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
