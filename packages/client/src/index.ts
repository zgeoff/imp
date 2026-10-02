export type {
  ApiCall,
  Checkpoint,
  DetachReason,
  Image,
  Imp,
  ImpEvent,
  ImpState,
  Session,
  SystemInfo,
} from '@imp/api';

export { ORPCError, isDefinedError, safe } from '@orpc/client';
export { CLIENT_VERSION } from './check-server';
export type { ServerCheck } from './check-server';
export { createImpClient } from './create-imp-client';
export type { ImpClient, ImpClientOptions } from './create-imp-client';
export type { RequireAwakeOptions } from './require-awake';
export { openExecSession } from './exec/open-exec-session';

export type {
  ExecOutcome,
  ExecSession,
  ExecSessionOptions,
  ExecStarted,
} from './exec/open-exec-session';

export { ExecError } from './exec/exec-error';
export type { ExecClientErrorCode } from './exec/exec-error';
export { CONSOLE_SHELL } from '@imp/api';

export type {
  AttachOptions,
  ConsoleOptions,
  ExecExit,
  ExecHandle,
  ExecOptions,
  RunOptions,
  RunResult,
} from './exec/open-exec';
