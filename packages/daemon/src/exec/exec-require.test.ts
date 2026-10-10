import { expect, test } from 'bun:test';
import { checkBrokerReady, isBrokerRequired } from './exec-require';

test.each([
  ['no list', undefined, false],
  ['an empty list', [], false],
  ['a list that names the broker', ['broker' as const], true],
])('#isBrokerRequired with %s returns %p', (_label, requirements, expected) => {
  expect(isBrokerRequired(requirements)).toBe(expected);
});

test('#checkBrokerReady lets the exec start with the broker variables as impd set them', () => {
  const broker = ['HTTPS_PROXY=http://10.66.0.1:7081', 'SSL_CERT_FILE=/etc/imp/broker-ca.pem'];

  expect(checkBrokerReady({ kind: 'ready', env: broker }, [...broker, 'TERM=xterm'])).toBeNull();
});

test('#checkBrokerReady refuses an imp with no grant', () => {
  expect(checkBrokerReady({ kind: 'ungranted' }, [])).toMatchObject({
    code: 'PRECONDITION_FAILED',
    message:
      'the broker is not ready for this exec: the imp has no grant, so impd sets no broker variables',
    data: {
      reason: 'broker_not_ready',
      detail: 'the imp has no grant, so impd sets no broker variables',
    },
  });
});

test('#checkBrokerReady refuses a boot of the guest without the broker CA bundle', () => {
  expect(checkBrokerReady({ kind: 'untrusted', detail: 'exited 127' }, [])).toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the broker CA bundle is not in this boot of the guest: exited 127',
    },
  });
});

test('#checkBrokerReady refuses a grant whose variables lack the proxy', () => {
  const env = ['SSL_CERT_FILE=/etc/imp/broker-ca.pem'];

  expect(checkBrokerReady({ kind: 'ready', env }, env)).toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: { reason: 'broker_not_ready', detail: 'impd built no HTTPS_PROXY for this exec' },
  });
});

test("#checkBrokerReady refuses an exec whose env replaced one of the broker's variables", () => {
  const broker = ['HTTPS_PROXY=http://10.66.0.1:7081', 'SSL_CERT_FILE=/etc/imp/broker-ca.pem'];

  expect(
    checkBrokerReady({ kind: 'ready', env: broker }, [
      'HTTPS_PROXY=',
      'SSL_CERT_FILE=/etc/imp/broker-ca.pem',
    ]),
  ).toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: "the exec's env sets HTTPS_PROXY, which the broker sets",
    },
  });
});
