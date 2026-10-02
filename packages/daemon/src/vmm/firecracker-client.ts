// Typed calls to the Firecracker API over its unix socket.

interface BootSource {
  readonly kernelImagePath: string;
  readonly bootArgs: string;
}

interface MachineConfig {
  readonly vcpuCount: number;
  readonly memSizeMib: number;
}

interface Drive {
  readonly driveId: string;
  readonly pathOnHost: string;
  readonly isRootDevice: boolean;
  readonly isReadOnly: boolean;
}

interface NetworkInterface {
  readonly ifaceId: string;
  readonly hostDevName: string;
  readonly guestMac: string;
}

interface Vsock {
  readonly guestCid: number;
  readonly udsPath: string;
}

// DESIGN 2.8: free page reporting hands memory the guest frees back to the
// host; deflate_on_oom keeps an inflated balloon from killing guest processes
interface Balloon {
  readonly amountMib: number;
  readonly deflateOnOom: boolean;
  readonly statsPollingIntervalS: number;
  readonly freePageReporting: boolean;
}

interface SnapshotFiles {
  readonly snapshotPath: string;
  readonly memFilePath: string;
}

export interface FirecrackerClient {
  readonly putBootSource: (source: BootSource) => Promise<void>;
  readonly putMachineConfig: (config: MachineConfig) => Promise<void>;
  readonly putDrive: (drive: Drive) => Promise<void>;

  // after boot: Firecracker reads the file's size again and tells the guest
  readonly patchDrive: (driveId: string, pathOnHost: string) => Promise<void>;
  readonly putNetworkInterface: (iface: NetworkInterface) => Promise<void>;
  readonly putVsock: (vsock: Vsock) => Promise<void>;

  // before InstanceStart only; a running or restored VM cannot add one
  readonly putBalloon: (balloon: Balloon) => Promise<void>;
  readonly instanceStart: () => Promise<void>;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;

  // a full snapshot; pause the VM first
  readonly createSnapshot: (files: SnapshotFiles) => Promise<void>;

  // only on a fresh Firecracker process, before any other configuration
  readonly loadSnapshot: (files: SnapshotFiles, resumeVm: boolean) => Promise<void>;
  readonly getVersion: () => Promise<string>;
}

interface FirecrackerTimeouts {
  readonly requestMs: number;
  readonly snapshotMs: number;
}

// A wedged Firecracker must not hold an imp's lock forever. A snapshot writes
// the whole guest memory, so it gets longer.
const DEFAULT_TIMEOUTS: FirecrackerTimeouts = { requestMs: 10_000, snapshotMs: 120_000 };

class FirecrackerApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, body: string) {
    super(`firecracker ${method} ${path}: ${String(status)} ${body}`);

    this.name = 'FirecrackerApiError';
    this.status = status;
  }
}

export function createFirecrackerClient(
  socketPath: string,
  timeouts: FirecrackerTimeouts = DEFAULT_TIMEOUTS,
): FirecrackerClient {
  const sendRequest = async (
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = timeouts.requestMs,
  ): Promise<string> => {
    const init: BunFetchRequestInit = {
      method,
      unix: socketPath,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(`http://localhost${path}`, init);
      const text = await response.text();

      if (!response.ok) {
        throw new FirecrackerApiError(method, path, response.status, text);
      }

      return text;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error(`firecracker ${method} ${path}: no answer within ${String(timeoutMs)} ms`, {
          cause: error,
        });
      }

      throw error;
    }
  };

  const sendPut = async (path: string, body: unknown, timeoutMs?: number): Promise<void> => {
    await sendRequest('PUT', path, body, timeoutMs);
  };

  return {
    putBootSource: (source) =>
      sendPut('/boot-source', {
        kernel_image_path: source.kernelImagePath,
        boot_args: source.bootArgs,
      }),
    putMachineConfig: (config) =>
      sendPut('/machine-config', { vcpu_count: config.vcpuCount, mem_size_mib: config.memSizeMib }),
    putDrive: (drive) =>
      sendPut(`/drives/${drive.driveId}`, {
        drive_id: drive.driveId,
        path_on_host: drive.pathOnHost,
        is_root_device: drive.isRootDevice,
        is_read_only: drive.isReadOnly,
      }),
    patchDrive: async (driveId, pathOnHost) => {
      await sendRequest('PATCH', `/drives/${driveId}`, {
        drive_id: driveId,
        path_on_host: pathOnHost,
      });
    },
    putNetworkInterface: (iface) =>
      sendPut(`/network-interfaces/${iface.ifaceId}`, {
        iface_id: iface.ifaceId,
        host_dev_name: iface.hostDevName,
        guest_mac: iface.guestMac,
      }),
    putVsock: (vsock) => sendPut('/vsock', { guest_cid: vsock.guestCid, uds_path: vsock.udsPath }),
    putBalloon: (balloon) =>
      sendPut('/balloon', {
        amount_mib: balloon.amountMib,
        deflate_on_oom: balloon.deflateOnOom,
        stats_polling_interval_s: balloon.statsPollingIntervalS,
        free_page_reporting: balloon.freePageReporting,
      }),
    instanceStart: () => sendPut('/actions', { action_type: 'InstanceStart' }),
    pause: async () => {
      await sendRequest('PATCH', '/vm', { state: 'Paused' });
    },
    resume: async () => {
      await sendRequest('PATCH', '/vm', { state: 'Resumed' });
    },
    createSnapshot: (files) =>
      sendPut(
        '/snapshot/create',
        {
          snapshot_type: 'Full',
          snapshot_path: files.snapshotPath,
          mem_file_path: files.memFilePath,
          sync_snapshot_files: true,
        },
        timeouts.snapshotMs,
      ),
    loadSnapshot: (files, resumeVm) =>
      sendPut(
        '/snapshot/load',
        {
          snapshot_path: files.snapshotPath,
          mem_backend: { backend_type: 'File', backend_path: files.memFilePath },
          resume_vm: resumeVm,
        },
        timeouts.snapshotMs,
      ),
    getVersion: async () => {
      const text = await sendRequest('GET', '/version');

      const parsed: unknown = JSON.parse(text);

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'firecracker_version' in parsed &&
        typeof parsed.firecracker_version === 'string'
      ) {
        return parsed.firecracker_version;
      }

      throw new Error(`firecracker GET /version: unexpected body ${text}`);
    },
  };
}
