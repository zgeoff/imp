import * as z from 'zod';

// A script that POSTs `path` to an imp-docker-proxy on `socket` with a
// context of FROM busybox, each [key, value] param sent as given and in
// order; it prints the answer's body, a space and the HTTP status.
export function buildProxyBuildScript(
  params: readonly (readonly [string, string])[],
  path: string,
  socket: string,
): string {
  const query = new URLSearchParams(params.map(([key, value]): [string, string] => [key, value]));

  return [
    String.raw`d=$(mktemp -d) && printf "FROM busybox\n" >"$d/Dockerfile" &&`,
    `tar -C "$d" -c Dockerfile | curl -sS --unix-socket ${socket}`,
    `-X POST -H 'Content-Type: application/x-tar' --data-binary @-`,
    `-w ' %{http_code}' 'http://docker${path}?${query.toString()}'`,
  ].join(' ');
}

const RefusalSchema = z.object({ message: z.string() });

export interface ProxyAnswer {
  readonly status: number;
  readonly message: string;
}

// The status and the refusal message from what buildProxyBuildScript
// printed: the proxy's JSON body, a space, and the status.
export function parseProxyAnswer(stdout: string): ProxyAnswer {
  const cut = stdout.lastIndexOf(' ');

  if (cut === -1) {
    throw new Error(`no status in ${JSON.stringify(stdout)}`);
  }

  const body = RefusalSchema.parse(JSON.parse(stdout.slice(0, cut)));

  return { status: Number(stdout.slice(cut + 1)), message: body.message };
}
