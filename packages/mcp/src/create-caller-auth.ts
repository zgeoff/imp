import type { Scope } from '@impz/api';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { ImpGuard } from './imp-guard';
import type { ToolClient } from './tools/tool-client';

// Who one request comes from: the client its tools call impd with, the guard
// on the imps they touch, and the scope that tools/list filters by
export interface McpCaller {
  readonly client: ToolClient;
  readonly guard: ImpGuard;
  readonly scope: Scope;
}

interface CallHooks {
  // runs when the request's tool call starts, past the SDK's checks
  readonly onCallStart: () => void;

  // runs once the request's tool call ends, answered or not
  readonly onCallEnd: () => void;
}

interface CallerAuth extends CallHooks {
  readonly caller: McpCaller;
}

// the caller behind each AuthInfo this module made; the SDK hands a request's
// AuthInfo to its handler as the same object
const callers = new WeakMap<AuthInfo, CallerAuth>();

// The AuthInfo that carries `caller` through the SDK to the request's handler.
// The SDK checks nothing in it: impd authenticated the request already.
export function createCallerAuth(
  caller: Readonly<McpCaller>,
  hooks: Partial<CallHooks> = {},
): AuthInfo {
  const authInfo: AuthInfo = { token: '', clientId: 'imp', scopes: [caller.scope] };

  callers.set(authInfo, {
    caller,
    onCallStart: hooks.onCallStart ?? (() => {}),
    onCallEnd: hooks.onCallEnd ?? (() => {}),
  });

  return authInfo;
}

// null for an AuthInfo this module did not make, or none
export function findCallerAuth(authInfo: AuthInfo | undefined): CallerAuth | null {
  return authInfo === undefined ? null : (callers.get(authInfo) ?? null);
}
