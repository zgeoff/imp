import type { GuestMemory } from '../vmm/vm-runner';

interface StubElasticGuestOptions {
  readonly baseMib: number;
  readonly usedMib: number;
  readonly pluggedMib: number;
  readonly requestedMib: number;

  // the hot-plug region: a request past it is refused
  readonly regionMib: number;

  // what one read finds unplugged since the last, as virtio-mem migrates
  // pages away a block at a time
  readonly stepMib: number;

  // an unplug stops here, as a guest stops at memory it cannot migrate
  readonly floorMib?: number;
}

// A guest's virtio-mem device as Firecracker reports it: each read moves the
// plugged size down by up to `stepMib` toward the request, never below the
// floor. `requests` records each requested size in order.
export function buildStubElasticGuest(options: Readonly<StubElasticGuestOptions>) {
  const floorMib = options.floorMib ?? 0;
  const guest = { pluggedMib: options.pluggedMib, requestedMib: options.requestedMib };
  const requests: number[] = [];

  return {
    guest,
    requests,
    vm: {
      readGuestMemory: (): Promise<GuestMemory> => {
        if (guest.requestedMib < guest.pluggedMib) {
          guest.pluggedMib = Math.max(
            guest.requestedMib,
            floorMib,
            guest.pluggedMib - options.stepMib,
          );
        }

        return Promise.resolve({
          pluggedMib: guest.pluggedMib,
          requestedMib: guest.requestedMib,
          totalMib: options.baseMib + guest.pluggedMib,
          availableMib: options.baseMib + guest.pluggedMib - options.usedMib,
        });
      },

      // Firecracker's PATCH /hotplug/memory takes whole 2 MiB blocks within
      // the region and answers 400 to anything else
      requestPluggedMib: (_paths: unknown, mib: number): Promise<void> => {
        if (!Number.isInteger(mib / 2) || mib < 0 || mib > options.regionMib) {
          return Promise.reject(
            new Error(
              `firecracker PATCH /hotplug/memory: 400 requested size ${String(mib)} MiB is not whole blocks within the region`,
            ),
          );
        }

        guest.requestedMib = mib;

        requests.push(mib);

        return Promise.resolve();
      },
    },
  };
}
