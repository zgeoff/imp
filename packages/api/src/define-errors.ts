import type { CommonORPCErrorCode } from '@orpc/client';
import type { ErrorMap } from '@orpc/contract';

type StatusedErrorMap<T extends ErrorMap> = {
  [K in keyof T]: K extends CommonORPCErrorCode
    ? T[K] & { status?: never }
    : T[K] & { status: number };
};

// A common oRPC code already carries its HTTP status; a custom one has none,
// so the type demands it here rather than letting it fall back to 500.
export function defineErrors<const T extends ErrorMap>(
  errors: Readonly<T & NoInfer<StatusedErrorMap<T>>>,
): T {
  return errors;
}
