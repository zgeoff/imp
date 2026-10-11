import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { createStubBin } from './create-stub-bin';

// The part of `tailscale status --json` that host/scripts/tailscale-up.sh reads.
interface StubTailscaleNode {
  readonly BackendState: string;
  readonly Self: {
    readonly HostName: string;
    readonly Tags: readonly string[];
    readonly TailscaleIPs: readonly string[];
    readonly DNSName: string;
  };
}

const SelfSchema = z.object({
  HostName: z.string(),
  Tags: z.array(z.string()),
  TailscaleIPs: z.array(z.string()),
  DNSName: z.string(),
});

const NodeSchema = z.object({ BackendState: z.string(), Self: SelfSchema });

export interface StubTailscale {
  // the directory that holds the stub, for the front of a child's PATH
  readonly bin: string;

  // makes `node` the one status reports
  readonly writeNode: (node: StubTailscaleNode) => void;

  // status reports Starting until releaseStart, whatever the node says
  readonly holdStart: () => void;
  readonly releaseStart: () => void;

  readonly readNode: () => StubTailscaleNode;

  // the arguments after --socket of each call with this verb, in order
  readonly readCalls: (verb: string) => readonly string[];
}

// A `tailscale` CLI in <dir>/bin, after the --socket=… it always gets first:
// `status` fails before any node is written, as with no tailscaled; `up`
// saves a Running node with its --hostname and --advertise-tags.
export function createStubTailscale(dir: string): StubTailscale {
  const status = join(dir, 'tailscale-status.json');
  const starting = join(dir, 'tailscale-starting');

  const stub = createStubBin(
    dir,
    'tailscale',
    String.raw`status=${JSON.stringify(status)}
starting=${JSON.stringify(starting)}
shift
case $1 in
  status)
    if [ -e "$starting" ]; then
      echo '{"BackendState": "Starting"}'
    else
      cat "$status"
    fi
    ;;
  up)
    hostname= tags=
    for arg in "$@"; do
      case $arg in
        --hostname=*) hostname=$(cut -d= -f2- <<<"$arg") ;;
        --advertise-tags=*) tags=$(cut -d= -f2- <<<"$arg") ;;
      esac
    done
    jq -n --arg host "$hostname" --arg tags "$tags" \
      '{BackendState: "Running", Self: {HostName: $host, Tags: ($tags | split(",")), TailscaleIPs: ["100.64.0.9"], DNSName: "imp.tail1234.ts.net."}}' \
      >"$status"
    ;;
  down)
    jq '.BackendState = "Stopped"' "$status" >"$status.new"
    mv "$status.new" "$status"
    ;;
esac`,
  );

  return {
    bin: stub.bin,
    writeNode: (node) => {
      writeFileSync(status, JSON.stringify(node));
    },
    holdStart: () => {
      writeFileSync(starting, '');
    },
    releaseStart: () => {
      rmSync(starting);
    },
    readNode: () => NodeSchema.parse(JSON.parse(readFileSync(status, 'utf8'))),
    readCalls: (verb) =>
      readFileSync(stub.calls, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('tailscale ') && line.split(' ')[2] === verb)
        .map((line) => line.split(' ').slice(2).join(' ')),
  };
}
