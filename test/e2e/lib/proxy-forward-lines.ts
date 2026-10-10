// What `imp proxy` prints for each forward it holds (proxy-client.ts and
// reverse-client.ts in packages/cli).

export interface ProxyForwards {
  // the local port of the forward into the imp
  readonly localPort: string | undefined;

  // the guest port of a TCP reverse forward
  readonly guestPort: string | undefined;

  // the guest path of a reverse forward on a socket
  readonly socketPath: string | undefined;
}

// the first forward of each kind in `imp proxy`'s stdout
export function parseProxyForwards(stdout: string): ProxyForwards {
  return {
    localPort: /forwarding localhost:(?<port>\d+) ->/v.exec(stdout)?.groups?.['port'],
    guestPort: /forwarding (?!localhost:)[^:\s]+:(?<port>\d+) ->/v.exec(stdout)?.groups?.['port'],
    socketPath: /forwarding [^:\s]+:(?<path>\/run\/imp\/forward\/\S+) ->/v.exec(stdout)?.groups?.[
      'path'
    ],
  };
}

// the guest path of a socket reverse forward that listens again after the
// imp's container restarted, from `imp proxy`'s stderr
export function findSocketListenAgain(stderr: string): string | undefined {
  return /forwarding [^:\s]+:(?<path>\/run\/imp\/forward\/\S+) -> \S+ again/v.exec(stderr)
    ?.groups?.['path'];
}
