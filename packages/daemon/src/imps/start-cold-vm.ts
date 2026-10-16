import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SlotAddress } from '../net/addressing';
import { GATEWAY_IP6 } from '../net/addressing6';
import { readErrorMessage } from '../read-error-message';
import type { ImpPaths } from '../storage/data-layout';
import type { ImpCgroup } from '../vmm/cpu-cgroups';
import { TemplateRestoreError } from '../vmm/template-vm';
import type { StartedVm } from '../vmm/vm-runner';
import { formatTimings } from './format-timings';
import type { ImpHost, ImpVms } from './imp-context';
import type { LockedImp } from './imp-lock';

// the claim's seed for the guest's entropy pool; the agent wants 32 or more
const CLAIM_SEED_BYTES = 64;

interface ColdVmStart {
  readonly imp: LockedImp;
  readonly paths: ImpPaths;
  readonly address: SlotAddress;
  readonly cgroup: ImpCgroup | null;

  // the host's part before the VM, for the boot's log line
  readonly hostSteps: Readonly<Record<string, number>>;
  readonly diskReady: Promise<unknown>;
}

// A cold boot: a restore of the shape's boot template when one is ready,
// else the kernel's boot. A template that fails to restore goes, and the
// imp boots the kernel (docs/architecture/lifecycle/boot-templates.md#restore).
export async function startColdVm(
  context: ImpHost & ImpVms,
  start: Readonly<ColdVmStart>,
): Promise<StartedVm> {
  const imp = start.imp;
  const paths = start.paths;
  const address = start.address;
  const cgroup = start.cgroup;
  const hostSteps = start.hostSteps;

  // a template has no hot-plug region: an elastic imp boots the kernel
  // (docs/architecture/lifecycle/elastic-memory.md#limits)
  const template =
    imp.maxMemoryMib > imp.memoryMib
      ? null
      : context.templates?.find({ vcpus: imp.vcpus, memoryMib: imp.memoryMib });

  // a disk that fails is the create's failure, not the template's
  const disk = { isFailed: false };

  const readDiskBytes = async () => {
    try {
      await start.diskReady;
    } catch (error) {
      disk.isFailed = true;
      throw error;
    }

    return statSync(paths.disk).size;
  };

  const diskBytes = readDiskBytes();

  // handled now: a restore that fails first never awaits it
  void Promise.allSettled([diskBytes]);

  if (template !== null && template !== undefined) {
    try {
      const vm = await context.vms.loadTemplateVm({
        firecrackerBin: context.config.firecrackerBin,
        paths,
        vmstate: template.vmstate,
        memFile: template.memFile,
        systemDrivePath: template.systemDrivePath,
        placeholderPath: template.placeholderPath,
        jail: context.findJailUser(imp),
        diskPath: resolve(paths.disk),
        tap: address.tap,
        cgroup,
        diskReady: diskBytes,
        claim: {
          id: imp.id,
          hostname: imp.name,
          ip: `${address.guestIp}/${String(address.prefixLength)}`,
          gw: address.hostIp,
          ip6: address.guestIp6 === null ? null : `${address.guestIp6}/128`,
          gw6: address.guestIp6 === null ? null : GATEWAY_IP6,
          dns: context.config.dns,
          mac: address.guestMac,
          seed: randomBytes(CLAIM_SEED_BYTES),
          isIdentityReset: imp.isIdentityResetPending,
        },
      });

      context.templates?.reportRestored(template);

      context.log(
        `impd: ${imp.name}: restored boot template ${template.key.slice(0, 12)} as pid ${String(vm.pid)} ${formatTimings({ ...hostSteps, ...vm.timings })}`,
      );

      return vm;
    } catch (error) {
      if (disk.isFailed) {
        await diskBytes;
      }

      context.log(
        `impd: ${imp.name}: boot template ${template.key.slice(0, 12)} failed, booting the kernel: ${readErrorMessage(error)}`,
      );

      // a failure of the imp's own (its disk, its claim) leaves the template
      const isTemplateFault = error instanceof TemplateRestoreError && error.isTemplateFault;

      context.templates?.reportFailure(template, isTemplateFault);
    }
  }

  await diskBytes;

  const vm = await context.vms.startVm({
    firecrackerBin: context.config.firecrackerBin,
    kernelPath: context.config.kernelPath,
    systemDrivePath: context.identity.systemDrivePath,
    paths,
    address,
    impId: imp.id,
    hostname: imp.name,
    vcpus: imp.vcpus,
    memoryMib: imp.memoryMib,
    maxMemoryMib: imp.maxMemoryMib,
    dns: context.config.dns,
    cgroup,
    isIdentityReset: imp.isIdentityResetPending,
    jail: context.findJailUser(imp),
  });

  context.log(
    `impd: ${imp.name}: booted pid ${String(vm.pid)} ${formatTimings({ ...hostSteps, ...vm.timings })}`,
  );

  return vm;
}
