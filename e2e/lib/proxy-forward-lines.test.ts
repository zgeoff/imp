import { expect, test } from 'bun:test';
import { findSocketListenAgain, parseProxyForwards } from './proxy-forward-lines';

test('#parseProxyForwards reads the local port, the guest port and the guest socket', () => {
  const stdout = [
    'forwarding localhost:41234 -> e2e-in-a:8080',
    'forwarding e2e-in-a:39876 -> localhost:5000',
    'forwarding e2e-in-a:/run/imp/forward/5000-1.sock -> localhost:5000',
    '',
  ].join('\n');

  expect(parseProxyForwards(stdout)).toStrictEqual({
    localPort: '41234',
    guestPort: '39876',
    socketPath: '/run/imp/forward/5000-1.sock',
  });
});

test('#parseProxyForwards reads nothing before the proxy printed its forwards', () => {
  expect(parseProxyForwards('')).toStrictEqual({
    localPort: undefined,
    guestPort: undefined,
    socketPath: undefined,
  });
});

test('#findSocketListenAgain reads the socket a reverse forward listens on again', () => {
  const stderr =
    'imp: the reverse forward lost its listener\nforwarding e2e-in-a:/run/imp/forward/5000-2.sock -> localhost:5000 again\n';

  expect(findSocketListenAgain(stderr)).toBe('/run/imp/forward/5000-2.sock');
});

test('#findSocketListenAgain reads nothing from the first listen', () => {
  expect(
    findSocketListenAgain('forwarding e2e-in-a:/run/imp/forward/5000-1.sock -> localhost:5000\n'),
  ).toBeUndefined();
});
