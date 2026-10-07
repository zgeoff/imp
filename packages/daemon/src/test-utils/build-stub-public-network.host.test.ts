import { expect, test } from 'bun:test';
import { buildStubPublicNetwork } from './build-stub-public-network';
import { canUnshare } from './can-unshare';
import { runInNetns } from './run-in-netns';

test.skipIf(!canUnshare(['ip', 'link']))(
  'it routes both guests to every address wan and ts answer on, with no ruleset',
  () => {
    // IPv6 neighbour discovery takes a second a hop on a first packet
    const run = runInNetns({
      script: `${buildStubPublicNetwork()}
reach() { ip netns exec "$1" ping -c 1 -W 4 "$2" >/dev/null 2>&1 && echo "$1>$2 yes" || echo "$1>$2 no"; }
for n in 0 3; do
  for target in 93.184.215.14 10.250.77.1 169.254.169.254 192.88.99.1 8.8.4.4 44.0.0.2 1.2.3.4 2606:4700::1111 64:ff9b::a00:1 2002:a00:1::1 2001:db8:77::1 2a01:4f8::7 2a00:44::2; do
    reach g$n $target
  done
done
`,
      env: {},
      mount: true,
    });

    expect(run).toStrictEqual({
      stdout: [
        'g0>93.184.215.14 yes',
        'g0>10.250.77.1 yes',
        'g0>169.254.169.254 yes',
        'g0>192.88.99.1 yes',
        'g0>8.8.4.4 yes',
        'g0>44.0.0.2 yes',
        'g0>1.2.3.4 yes',
        'g0>2606:4700::1111 yes',
        'g0>64:ff9b::a00:1 yes',
        'g0>2002:a00:1::1 yes',
        'g0>2001:db8:77::1 yes',
        'g0>2a01:4f8::7 yes',
        'g0>2a00:44::2 yes',
        'g3>93.184.215.14 yes',
        'g3>10.250.77.1 yes',
        'g3>169.254.169.254 yes',
        'g3>192.88.99.1 yes',
        'g3>8.8.4.4 yes',
        'g3>44.0.0.2 yes',
        'g3>1.2.3.4 yes',
        'g3>2606:4700::1111 yes',
        'g3>64:ff9b::a00:1 yes',
        'g3>2002:a00:1::1 yes',
        'g3>2001:db8:77::1 yes',
        'g3>2a01:4f8::7 yes',
        'g3>2a00:44::2 yes',
        '',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });
  },
);
