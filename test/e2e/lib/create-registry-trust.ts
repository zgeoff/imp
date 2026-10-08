import { join } from 'node:path';
import { runCommand } from './instance';

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
}

export interface RegistryTrust {
  // <certsRoot>/<registry>, which this call made
  readonly dir: string;

  // removes dir, once; safe to call again
  readonly remove: () => Promise<void>;
}

async function runAs(asRoot: readonly string[], argv: readonly string[]): Promise<void> {
  const result = await runCommand([...asRoot, ...argv]);

  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`);
  }
}

// Makes the engine trust a registry's certificate through Docker's fixed
// certs.d path, in a directory this call makes: it refuses an existing one
// untouched, and removes only its own, never certsRoot.
export async function createRegistryTrust(
  options: Readonly<RegistryTrustOptions>,
): Promise<RegistryTrust> {
  const certsRoot = options.certsRoot ?? '/etc/docker/certs.d';
  const asRoot = options.asRoot ?? ['sudo', '--non-interactive'];
  const dir = join(certsRoot, options.registry);

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

  // a failed copy leaves no half-made directory behind
  await runAs(asRoot, ['cp', options.certPath, join(dir, 'ca.crt')]).catch(
    async (error: unknown) => {
      await remove();

      throw error;
    },
  );

  return { dir, remove };
}
