export type {
  ApiCall,
  Checkpoint,
  DetachReason,
  ExecRequirement,
  Identity,
  Image,
  ImageBuildPhase,
  ImageBuildProgress,
  Imp,
  ImpEvent,
  ImpState,
  Scope,
  ColdBoot,
  ColdBootCause,
  InvalidResumeData,
  NoSessionData,
  PreviousGeneration,
  ResumeFrom,
  ResumeResult,
  Session,
  SessionLog,
  SessionLogRead,
  SessionOutput,
  SshKey,
  SystemInfo,
  Token,
} from '@impz/api';

export { ORPCError, isDefinedError, safe } from '@orpc/client';
export { CLIENT_VERSION } from './check-server';
export type { ServerCheck } from './check-server';
export { createImpClient } from './create-imp-client';
export type { ImpClient, ImpClientOptions } from './create-imp-client';
export type { BuildContext, BuildImageOptions } from './build-image';
export type { RequireAwakeOptions } from './require-awake';
export { openExecSession } from './exec/open-exec-session';
export { openToolExec } from './exec/open-tool-exec';
export type { ToolExec, ToolExecOptions } from './exec/open-tool-exec';
export { UnknownProcedureError } from './unknown-procedure-error';
export { resolveImpdWebSocketUrl } from './resolve-impd-web-socket-url';
export { watchEvents } from './events/watch-events';
export type { EventSource, WatchEventsOptions, WatchReconnect } from './events/watch-events';

export {
  MissingFeatureError,
  findMissingFeatures,
  readFeatures,
  requireFeatures,
} from './require-features';

export type { FeatureNeeds, FeatureSource, ImpdFeature, ImpdFeatures } from './require-features';

export type {
  ExecOutcome,
  ExecSession,
  ExecSessionOptions,
  ExecSocket,
  ExecStarted,
} from './exec/open-exec-session';

export { openForwardTunnel } from './tunnel/open-forward-tunnel';

export type {
  ForwardTunnel,
  ForwardTunnelEnd,
  ForwardTunnelOptions,
} from './tunnel/open-forward-tunnel';

export { openReverseForward } from './tunnel/open-reverse-forward';

export type {
  ReverseForward,
  ReverseForwardEnd,
  ReverseForwardOptions,
  ReverseGuest,
  ReverseListening,
  ReverseRelay,
  ReverseRelayHandlers,
} from './tunnel/open-reverse-forward';

export { ExecError } from './exec/exec-error';
export type { ExecClientErrorCode } from './exec/exec-error';
export { InvalidResumeError } from './exec/invalid-resume-error';
export { InvalidStateError } from './exec/invalid-state-error';
export type { InvalidStateData } from './exec/invalid-state-error';
export { NoSessionError } from './exec/no-session-error';
export { CONSOLE_SHELL, EXEC_REQUIREMENTS } from '@impz/api';

export type {
  AttachOptions,
  ConsoleOptions,
  ExecExit,
  ExecHandle,
  ExecOptions,
  RunOptions,
  RunResult,
} from './exec/open-exec';
