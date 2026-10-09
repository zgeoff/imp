import type { ImpPaths } from '../storage/data-layout';
import type { GuestMemory } from '../vmm/vm-runner';

interface StubGuest {
  baseMib: number;
  pluggedMib: number;
  requestedMib: number;
  usedMib: number;

  // the hot-plug region: a request past it is refused
  regionMib: number;

  // an unplug stops here, as a guest stops at memory it cannot migrate
  unplugFloorMib: number;

  // true: a request is taken, but the guest has not moved yet
  isSlow: boolean;
}

// virtio-mem plugs and unplugs whole 2 MiB blocks
const BLOCK_MIB = 2;

// The virtio-mem devices of running guests, keyed by imp dir. A read finds a
// plug or unplug done, down to the floor, unless the guest is slow; a call
// for a VM it does not hold rejects, as the runner's does for a VM gone.
export function buildStubGuestMemory() {
  const guests = new Map<string, StubGuest>();

  const requests: number[] = [];

  const readGuest = (paths: Pick<ImpPaths, 'dir'>): Promise<StubGuest> => {
    const guest = guests.get(paths.dir);

    return guest === undefined ? Promise.reject(new Error('no such VM')) : Promise.resolve(guest);
  };

  return {
    requests,

    // a running guest: 512 MiB base, 300 used, a 1024 MiB region and
    // nothing plugged, unless `guest` says otherwise
    addGuest: (paths: Pick<ImpPaths, 'dir'>, guest: Partial<StubGuest> = {}): StubGuest => {
      const added: StubGuest = {
        baseMib: 512,
        pluggedMib: 0,
        requestedMib: 0,
        usedMib: 300,
        regionMib: 1024,
        unplugFloorMib: 0,
        isSlow: false,
        ...guest,
      };

      guests.set(paths.dir, added);

      return added;
    },
    vms: {
      readGuestMemory: async (paths: Pick<ImpPaths, 'dir'>): Promise<GuestMemory> => {
        const guest = await readGuest(paths);

        if (!guest.isSlow) {
          guest.pluggedMib = Math.max(
            guest.requestedMib,
            Math.min(guest.pluggedMib, guest.unplugFloorMib),
          );
        }

        const totalMib = guest.baseMib + guest.pluggedMib;

        return {
          pluggedMib: guest.pluggedMib,
          requestedMib: guest.requestedMib,
          totalMib,
          availableMib: totalMib - guest.usedMib,
        };
      },

      // Firecracker's PATCH /hotplug/memory takes whole blocks within the
      // region and answers 400 to anything else
      requestPluggedMib: async (paths: Pick<ImpPaths, 'dir'>, mib: number): Promise<void> => {
        const guest = await readGuest(paths);

        if (!Number.isInteger(mib / BLOCK_MIB) || mib < 0 || mib > guest.regionMib) {
          throw new Error(
            `firecracker PATCH /hotplug/memory: 400 requested size ${String(mib)} MiB is not whole blocks within the region`,
          );
        }

        guest.requestedMib = mib;

        requests.push(mib);
      },
    },
  };
}
