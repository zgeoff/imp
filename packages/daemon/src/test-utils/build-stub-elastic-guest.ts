import type { GuestMemory } from '../vmm/vm-runner';

interface StubElasticGuestOptions {
  readonly baseMib: number;
  readonly usedMib: number;
  readonly pluggedMib: number;
  readonly requestedMib: number;

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
      requestPluggedMib: (_paths: unknown, mib: number): Promise<void> => {
        guest.requestedMib = mib;

        requests.push(mib);

        return Promise.resolve();
      },
    },
  };
}
