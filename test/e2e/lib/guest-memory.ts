import { requireImp, runShellInImp } from './imp-cli';

// Thin glue over a live guest and impd, with nothing to test without one.

// a /proc/meminfo field of the guest, in kB
async function readMeminfoKib(name: string, field: string): Promise<number> {
  const stdout = await runShellInImp(
    name,
    `grep '^${field}:' /proc/meminfo | tr -s ' ' | cut -d' ' -f2`,
  );

  return Number(stdout.trim());
}

// the guest's MemTotal in MiB
export async function readMemTotalMib(name: string): Promise<number> {
  return Math.round((await readMeminfoKib(name, 'MemTotal')) / 1024);
}

// the guest's MemAvailable in MiB: the value its balloon statistics report
export async function readMemAvailableMib(name: string): Promise<number> {
  return Math.floor((await readMeminfoKib(name, 'MemAvailable')) / 1024);
}

// an awake elastic imp always reports it: a missing field is a failure, not 0
export async function readPluggedMib(name: string): Promise<number> {
  const row = await requireImp(name);

  if (row.pluggedMib === undefined) {
    throw new Error(`${name} reports no pluggedMib`);
  }

  return row.pluggedMib;
}
