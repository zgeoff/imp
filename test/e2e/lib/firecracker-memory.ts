const KIB_PER_MIB = 1024;

// One line per Firecracker in the container: "<Pss> <Pss_Anon> <Pss_Shmem>"
// in kB from its smaps_rollup, read without impd; "-" for a missing field.
export const FIRECRACKER_MEMORY_SCRIPT = `
for pid in $(pgrep -x firecracker); do
  awk '/^Pss:/ { p = $2 } /^Pss_Anon:/ { a = $2 } /^Pss_Shmem:/ { s = $2 }
    END { if (p != "") print p, (a == "" ? "-" : a), (s == "" ? "-" : s) }' \
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
}

// sums FIRECRACKER_MEMORY_SCRIPT's output; a process gone between pgrep and
// its read prints nothing. A missing field throws: read as 0, it would let
// a breach of the budget pass.
export function parseFirecrackerMemory(output: string): FirecrackerMemory {
  let pssKib = 0;
  let ownedKib = 0;
  let count = 0;

  for (const line of output.split('\n')) {
    if (line.trim() === '') {
      continue;
    }

    const fields = line.trim().split(/\s+/).map(Number);

    if (fields.length !== 3 || fields.some((field) => !Number.isInteger(field))) {
      throw new Error(`smaps_rollup without Pss, Pss_Anon and Pss_Shmem: '${line}'`);
    }

    const [pss = 0, anon = 0, shmem = 0] = fields;

    pssKib += pss;
    ownedKib += anon + shmem;
    count += 1;
  }

  return {
    pssMib: Math.floor(pssKib / KIB_PER_MIB),
    ownedMib: Math.floor(ownedKib / KIB_PER_MIB),
    count,
  };
}
