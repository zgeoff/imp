import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { runCommand } from './instance';

// what proves a trust directory is this harness's: the file, and the process
// that made it, by pid and start time
export const OWNER_FILE = 'imp-e2e-owner';
const OwnerSchema = z.object({ pid: z.int(), startTime: z.string() });

// a process's start time in clock ticks since boot (field 22 of its stat),
// which a reused pid does not share; null when no such process runs
function readStartTime(procRoot: string, pid: number): string | null {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');

    // the command name may hold spaces: the fields after it start past ')'
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

export interface RegistryTrustOptions {
  // host:port, the name of the registry's directory under certsRoot
  readonly registry: string;

  // the registry's certificate, PEM, which the engine then trusts as its CA
  readonly certPath: string;

  // Docker's per-registry trust directories, which the engine reads on each
  // request; /etc/docker/certs.d by default
  readonly certsRoot?: string;

  // what runs each command as a user who may write certsRoot; sudo with no
  // password by default
  readonly asRoot?: readonly string[];

  // /proc by default, where the owner's start time is read
  readonly procRoot?: string;
}

export interface RegistryTrust {
  // <certsRoot>/<registry>, which this call made
  readonly dir: string;

  // removes dir, once; safe to call again
  readonly remove: () => Promise<void>;
}

async function runAs(
  asRoot: readonly string[],
  argv: readonly string[],
  stdin?: string,
): Promise<void> {
  const input = stdin === undefined ? {} : { stdin };

  const result = await runCommand([...asRoot, ...argv], input);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
}

// Trusts a registry's certificate through Docker's certs.d path, in a
// directory this call makes after it sweeps the host's stale ones; it
// refuses one still there, and removes only its own, never certsRoot.
export async function createRegistryTrust(
  options: Readonly<RegistryTrustOptions>,
): Promise<RegistryTrust> {
  const certsRoot = options.certsRoot ?? '/etc/docker/certs.d';
  const asRoot = options.asRoot ?? ['sudo', '--non-interactive'];
  const procRoot = options.procRoot ?? '/proc';
  const dir = join(certsRoot, options.registry);
  const startTime = readStartTime(procRoot, process.pid);

  // a directory whose owner cannot be proven later is one no run may remove
  if (startTime === null) {
    throw new Error(
      `refusing to trust ${options.registry}: this process's start time is unreadable`,
    );
  }

  const host = options.registry.slice(0, options.registry.lastIndexOf(':'));

  await removeStaleRegistryTrusts({ name: host, certsRoot, asRoot, procRoot });
  await runAs(asRoot, ['mkdir', '--parents', certsRoot]);

  // no --parents: mkdir fails on a directory that is already there, so the
  // check and the claim are one step
  const made = await runCommand([...asRoot, 'mkdir', dir]);

  if (made.exitCode !== 0) {
    throw new Error(`refusing to trust ${options.registry}: ${made.stderr.trim()}`);
  }

  let isRemoved = false;

  const remove = async () => {
    if (isRemoved) {
      return;
    }

    isRemoved = true;

    await runAs(asRoot, ['rm', '--recursive', '--force', dir]);
  };

  const owner = JSON.stringify({ pid: process.pid, startTime });

  // a failed write leaves no half-made directory behind
  try {
    await runAs(asRoot, ['tee', join(dir, OWNER_FILE)], owner);
    await runAs(asRoot, ['cp', options.certPath, join(dir, 'ca.crt')]);
  } catch (error) {
    await remove();

    throw error;
  }

  return { dir, remove };
}

// the owner file of a trust directory, or null when it has none or it does
// not parse
function readOwner(dir: string): z.infer<typeof OwnerSchema> | null {
  try {
    const text = readFileSync(join(dir, OWNER_FILE), 'utf8');
    const parsed = OwnerSchema.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface StaleTrustOptions {
  // the registry's host name: only <name>:<port> directories are looked at
  readonly name: string;
  readonly certsRoot?: string;
  readonly asRoot?: readonly string[];
  readonly procRoot?: string;
}

// Removes the <name>:* directories whose owner file parses and whose pid's
// start time is not the recorded one (gone, or reused); any other proves
// nothing and stays. Returns what it removed.
export async function removeStaleRegistryTrusts(
  options: Readonly<StaleTrustOptions>,
): Promise<readonly string[]> {
  const certsRoot = options.certsRoot ?? '/etc/docker/certs.d';
  const asRoot = options.asRoot ?? ['sudo', '--non-interactive'];
  const procRoot = options.procRoot ?? '/proc';
  const removed: string[] = [];
  let entries: readonly string[] = [];

  try {
    entries = readdirSync(certsRoot);
  } catch {
    return removed;
  }

  for (const entry of entries.filter((name) => name.startsWith(`${options.name}:`))) {
    const dir = join(certsRoot, entry);
    const owner = readOwner(dir);

    // no owner file, or one that does not parse: not this harness's
    if (owner !== null && readStartTime(procRoot, owner.pid) !== owner.startTime) {
      await runAs(asRoot, ['rm', '--recursive', '--force', dir]);

      removed.push(dir);
    }
  }

  return removed;
}
