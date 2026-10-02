import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { REPO_ROOT, runChecked } from './instance';

const WordsSchema = z.array(z.string());
const ProbedSchema = z.object({ path: z.string(), args: WordsSchema });

const ArgsSchema = z.object({
  privileges: z.array(WordsSchema),
  probed: z.array(ProbedSchema),
});

const ListSchema = WordsSchema.nullable();
const DeviceSchema = z.object({ PathOnHost: z.string() });

const HostConfigSchema = z.object({
  Privileged: z.boolean(),
  CapAdd: ListSchema,
  CapDrop: ListSchema,
  SecurityOpt: ListSchema,
  Devices: z.array(DeviceSchema).nullable(),
});

const InspectSchema = z.array(z.object({ HostConfig: HostConfigSchema }));

export interface HostConfig {
  readonly Privileged: boolean;
  readonly CapAdd: readonly string[] | null;
  readonly CapDrop: readonly string[] | null;
  readonly SecurityOpt: readonly string[] | null;
  readonly Devices: readonly { readonly PathOnHost: string }[] | null;
}

// scripts/dev.sh's own device, for the loop file its XFS lives in
const DEV_DEVICES = ['/dev/loop-control'];
const SECCOMP_PREFIX = 'seccomp=';

export interface ExpectedPrivileges {
  // as docker inspect spells them: CAP_SYS_ADMIN
  readonly caps: readonly string[];

  // every --security-opt but seccomp, which docker inspect shows inline
  readonly securityOpts: readonly string[];
  readonly seccomp: unknown;
  readonly devices: readonly string[];

  // devices a container may also have: probed ones the host has, and dev.sh's
  readonly optionalDevices: readonly string[];
}

// the words that follow each `flag` in `words`
function readFlagValues(words: readonly string[], flag: string): string[] {
  return words.flatMap((word, index) => (words[index - 1] === flag ? [word] : []));
}

// deploy/imp-host.args.json's privileges, with the profile its seccomp
// option names (seccompJson)
export function readExpectedPrivileges(argsJson: string, seccompJson: string): ExpectedPrivileges {
  const args = ArgsSchema.parse(JSON.parse(argsJson));
  const words = args.privileges.flat();

  return {
    caps: readFlagValues(words, '--cap-add')
      .map((cap) => `CAP_${cap}`)
      .toSorted(),
    securityOpts: readFlagValues(words, '--security-opt')
      .filter((opt) => !opt.startsWith(SECCOMP_PREFIX))
      .toSorted(),
    seccomp: JSON.parse(seccompJson),
    devices: readFlagValues(words, '--device').toSorted(),
    optionalDevices: [
      ...args.probed.flatMap((entry) => readFlagValues(entry.args, '--device')),
      ...DEV_DEVICES,
    ],
  };
}

function findSeccompDrift(opts: readonly string[], expected: unknown): string | null {
  const seccomp = opts.filter((opt) => opt.startsWith(SECCOMP_PREFIX));

  if (seccomp.length !== 1) {
    return `it has ${String(seccomp.length)} seccomp options, not 1`;
  }

  const profile: unknown = JSON.parse((seccomp[0] ?? '').slice(SECCOMP_PREFIX.length));

  return Bun.deepEquals(profile, expected)
    ? null
    : 'its seccomp profile is not deploy/imp-host.seccomp.json';
}

function findDeviceDrift(host: HostConfig, expected: ExpectedPrivileges): string | null {
  const devices = (host.Devices ?? []).map((device) => device.PathOnHost);
  const missing = expected.devices.filter((device) => !devices.includes(device));

  const allowed = new Set([...expected.devices, ...expected.optionalDevices]);

  const extra = devices.filter((device) => !allowed.has(device));

  if (missing.length > 0 || extra.length > 0) {
    return `its devices lack ${missing.join(' ') || 'none'} and add ${extra.join(' ') || 'none'}`;
  }

  return null;
}

// why the container's privileges differ from the deploy's, or null
export function findPrivilegeDrift(host: HostConfig, expected: ExpectedPrivileges): string | null {
  if (host.Privileged) {
    return 'it runs --privileged';
  }

  if (!(host.CapDrop ?? []).includes('ALL')) {
    return 'it keeps the default capabilities (no --cap-drop ALL)';
  }

  const caps = (host.CapAdd ?? []).toSorted();

  if (caps.join(' ') !== expected.caps.join(' ')) {
    return `it adds ${caps.join(' ')}, not ${expected.caps.join(' ')}`;
  }

  const opts = host.SecurityOpt ?? [];
  const others = opts.filter((opt) => !opt.startsWith(SECCOMP_PREFIX)).toSorted();

  if (others.join(' ') !== expected.securityOpts.join(' ')) {
    return `its security options are ${others.join(' ')}, not ${expected.securityOpts.join(' ')}`;
  }

  return findSeccompDrift(opts, expected.seccomp) ?? findDeviceDrift(host, expected);
}

// Every suite runs on the deploy's privileges, so a capability the code
// newly needs fails here, not in production.
export async function checkPrivileges(container: string): Promise<void> {
  const deploy = join(REPO_ROOT, 'deploy');

  const expected = readExpectedPrivileges(
    readFileSync(join(deploy, 'imp-host.args.json'), 'utf8'),
    readFileSync(join(deploy, 'imp-host.seccomp.json'), 'utf8'),
  );

  const inspected = await runChecked(['docker', 'inspect', container]);

  const [info] = InspectSchema.parse(JSON.parse(inspected));

  if (info === undefined) {
    throw new Error(`docker inspect ${container} returned nothing`);
  }

  const drift = findPrivilegeDrift(info.HostConfig, expected);

  if (drift !== null) {
    throw new Error(`${container} does not match deploy/imp-host.args.json: ${drift}`);
  }
}
