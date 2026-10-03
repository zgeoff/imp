const KIB_PER_MIB = 1024;

// One line per Firecracker in the container, read without impd:
// "<imp id> <Pss> <Pss_Anon> <Pss_Shmem>", the id from the --id the jailer
// passes on, the sizes in kB from its smaps_rollup; "-" for a missing field.
export const FIRECRACKER_MEMORY_SCRIPT = `
for pid in $(pgrep -x firecracker); do
  id=$(tr '\\0' '\\n' < /proc/$pid/cmdline 2>/dev/null | awk 'prev == "--id" { print; exit } { prev = $0 }')
  awk -v id="\${id:--}" '/^Pss:/ { p = $2 } /^Pss_Anon:/ { a = $2 } /^Pss_Shmem:/ { s = $2 }
    END { if (p != "") print id, p, (a == "" ? "-" : a), (s == "" ? "-" : s) }' \
    /proc/$pid/smaps_rollup 2>/dev/null
done`;

export interface FirecrackerMemory {
  // every resident page, clean file pages included: the copy of the
  // firecracker binary each jail holds and the boot template's mem file
  readonly pssMib: number;

  // anonymous and shmem pages: what the governor counts and the budget caps
  // (docs/architecture/sleep-and-wake.md#5-ram-what-the-governor-measures)
  readonly ownedMib: number;
  readonly count: number;

  // what each VM owns, by its imp's id
  readonly ownedByImpMib: ReadonlyMap<string, number>;
}

// sums FIRECRACKER_MEMORY_SCRIPT's output; a process gone between pgrep and
// its read prints nothing. A missing field throws: read as 0, it would let
// a breach of the budget pass.
export function parseFirecrackerMemory(output: string): FirecrackerMemory {
  const ownedByImpMib = new Map<string, number>();

  let pssKib = 0;
  let ownedKib = 0;
  let count = 0;

  for (const line of output.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    const [id = '-', ...rest] = line.trim().split(/\s+/);
    const fields = rest.map(Number);

    if (fields.length !== 3 || fields.some((field) => !Number.isInteger(field))) {
      throw new Error(`smaps_rollup without Pss, Pss_Anon and Pss_Shmem: '${line}'`);
    }

    const [pss = 0, anon = 0, shmem = 0] = fields;

    pssKib += pss;
    ownedKib += anon + shmem;
    count += 1;

    if (id !== '-') {
      ownedByImpMib.set(id, Math.floor((anon + shmem) / KIB_PER_MIB));
    }
  }

  return {
    pssMib: Math.floor(pssKib / KIB_PER_MIB),
    ownedMib: Math.floor(ownedKib / KIB_PER_MIB),
    count,
    ownedByImpMib,
  };
}

// The smallest RAM the given imps own, from smaps, not impd's figure: impd
// samples an imp's RAM every few seconds, so a new imp's can be stale.
export function readSmallestOwnedMib(impIds: readonly string[], memory: FirecrackerMemory): number {
  const owned = impIds.map((id) => {
    const mib = memory.ownedByImpMib.get(id);

    if (mib === undefined) {
      throw new Error(`no Firecracker for imp ${id}`);
    }

    return mib;
  });

  return Math.min(...owned);
}
