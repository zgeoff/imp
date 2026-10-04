import type { ExecRequirement } from '@imp/api';
import { ORPCError } from '@orpc/server';
import { PROXY_VARIABLE } from '../broker/guest-trust';
import type { BrokerExecEnv } from '../broker/guest-trust';
import { readEnvKey } from './merge-env';

// An exec's `require` (docs/guides/connectors.md#requiring-the-broker):
// `broker` holds when impd set the broker's variables and the CA bundle for
// this boot of the guest. It says nothing of whether the command honours them.

export function isBrokerRequired(requirements: readonly ExecRequirement[] | undefined): boolean {
  return requirements?.includes('broker') === true;
}

export function buildBrokerNotReadyError(detail: string) {
  return new ORPCError('PRECONDITION_FAILED', {
    message: `the broker is not ready for this exec: ${detail}`,
    data: { reason: 'broker_not_ready' as const, detail },
  });
}

// The refusal for an exec that requires the broker, given the broker's part
// and the environment the command would start with; null to start it.
export function checkBrokerReady(
  broker: BrokerExecEnv,
  env: readonly string[],
): ReturnType<typeof buildBrokerNotReadyError> | null {
  if (broker.kind === 'ungranted') {
    return buildBrokerNotReadyError('the imp has no grant, so impd sets no broker variables');
  }

  if (broker.kind === 'untrusted') {
    return buildBrokerNotReadyError(
      `the broker CA bundle is not in this boot of the guest: ${broker.detail}`,
    );
  }

  if (!broker.env.some((entry) => readEnvKey(entry) === PROXY_VARIABLE)) {
    return buildBrokerNotReadyError(`impd built no ${PROXY_VARIABLE} for this exec`);
  }

  // the caller's env wins over the broker's, so an entry it replaced is not
  // there as impd set it
  const started = new Set(env);

  const replaced = broker.env.find((entry) => !started.has(entry));

  if (replaced !== undefined) {
    return buildBrokerNotReadyError(
      `the exec's env sets ${readEnvKey(replaced)}, which the broker sets`,
    );
  }

  return null;
}
