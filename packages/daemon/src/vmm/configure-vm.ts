import type { FirecrackerClient } from './firecracker-client';

// milliseconds per step, for the timing breakdown in the log
export function createMarks() {
  const marks: Record<string, number> = {};
  let last = performance.now();

  const setMark = (step: string): void => {
    const now = performance.now();

    marks[step] = Math.round(now - last);
    last = now;
  };

  return { marks, setMark };
}

interface VmConfig {
  readonly kernelPath: string;
  readonly bootArgs: string;
  readonly vcpus: number;
  readonly memoryMib: number;
  readonly diskPath: string;
  readonly systemDrivePath: string;
  readonly vsockPath: string;
  readonly tap: string;
  readonly guestMac: string;
}

// The devices of every cold boot, a boot template's too: a template restore
// takes the snapshot's devices, so both must be the same
// (docs/architecture/boot-templates.md#key).
export async function setupVm(
  api: Readonly<FirecrackerClient>,
  config: Readonly<VmConfig>,
): Promise<void> {
  await api.putBootSource({ kernelImagePath: config.kernelPath, bootArgs: config.bootArgs });
  await api.putMachineConfig({ vcpuCount: config.vcpus, memSizeMib: config.memoryMib });

  // drives enumerate in PUT order: rootfs is vda, the system drive vdb;
  // neither is a Firecracker root device, which would add root=/dev/vda
  await api.putDrive({
    driveId: 'rootfs',
    pathOnHost: config.diskPath,
    isRootDevice: false,
    isReadOnly: false,
  });

  await api.putDrive({
    driveId: 'system',
    pathOnHost: config.systemDrivePath,
    isRootDevice: false,
    isReadOnly: true,
  });

  await api.putVsock({ guestCid: 3, udsPath: config.vsockPath });

  await api.putNetworkInterface({
    ifaceId: 'eth0',
    hostDevName: config.tap,
    guestMac: config.guestMac,
  });

  await api.putBalloon(BALLOON);
}

// the balloon every VM gets, part of a boot template's key
export const BALLOON = {
  amountMib: 0,
  deflateOnOom: true,
  statsPollingIntervalS: 1,
  freePageReporting: true,
} as const;
