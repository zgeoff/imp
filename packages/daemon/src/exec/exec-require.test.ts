import { expect, test } from 'bun:test';
import type { BrokerExecEnv } from '../broker/guest-trust';
import { checkBrokerReady, isBrokerRequired } from './exec-require';

// the refusal's detail, or null when the exec may start
function readDetail(broker: BrokerExecEnv, env: readonly string[]): string | null {
  return checkBrokerReady(broker, env)?.data.detail ?? null;
}

const BROKER = ['HTTPS_PROXY=http://10.66.0.1:7081', 'SSL_CERT_FILE=/etc/imp/broker-ca.pem'];

test('only a list that names the broker requires it', () => {
  expect(isBrokerRequired(undefined)).toBe(false);
  expect(isBrokerRequired([])).toBe(false);
  expect(isBrokerRequired(['broker'])).toBe(true);
});

test('the broker is ready with its variables as impd set them', () => {
  const env = [...BROKER, 'TERM=xterm'];

  expect(readDetail({ kind: 'ready', env: BROKER }, env)).toBeNull();
});

test('each cause of a refusal is named in its detail', () => {
  expect(checkBrokerReady({ kind: 'ungranted' }, [])?.data.reason).toBe('broker_not_ready');

  expect(readDetail({ kind: 'ungranted' }, [])).toBe(
    'the imp has no grant, so impd sets no broker variables',
  );

  expect(readDetail({ kind: 'untrusted', detail: 'exited 127' }, [])).toBe(
    'the broker CA bundle is not in this boot of the guest: exited 127',
  );

  // a grant whose variables lack the proxy: nothing to route through
  const proxyless = BROKER.slice(1);

  expect(readDetail({ kind: 'ready', env: proxyless }, proxyless)).toBe(
    'impd built no HTTPS_PROXY for this exec',
  );

  // the caller's env replaced one
  const replaced = ['HTTPS_PROXY=', BROKER[1] ?? ''];

  expect(readDetail({ kind: 'ready', env: BROKER }, replaced)).toBe(
    "the exec's env sets HTTPS_PROXY, which the broker sets",
  );
});
