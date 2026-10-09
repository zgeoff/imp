import type { ImpPaths } from '../storage/data-layout';
import type { GuestMemory } from '../vmm/vm-runner';

interface StubGuest {
  baseMib: number;
  pluggedMib: number;
  requestedMib: number;
  usedMib: number;

  // an unplug stops here, as a guest stops at memory it cannot migrate
  unplugFloorMib: number;

  // true: a request is taken, but the guest has not moved yet
  isSlow: boolean;
}

// The virtio-mem devices of running guests, keyed by imp dir. A read finds a
// plug or unplug done, down to the floor, unless the guest is slow; a VM it
// does not hold throws, as the runner does for a VM that is gone.
export function buildStubGuestMemory() {
  const guests = new Map<string, StubGuest>();

  const requests: number[] = [];

  const readGuest = (paths: Pick<ImpPaths, 'dir'>): StubGuest => {
    const guest = guests.get(paths.dir);

    if (guest === undefined) {
      throw new Error('no such VM');
    }

    return guest;
  };

  return {
    requests,

    // a running guest: 512 MiB base, 300 used and nothing plugged, unless
    // `guest` says otherwise
    addGuest: (paths: Pick<ImpPaths, 'dir'>, guest: Partial<StubGuest> = {}): StubGuest => {
      const added: StubGuest = {
        baseMib: 512,
        pluggedMib: 0,
        requestedMib: 0,
        usedMib: 300,
        unplugFloorMib: 0,
        isSlow: false,
        ...guest,
      };

      guests.set(paths.dir, added);

      return added;
    },
    vms: {
      readGuestMemory: (paths: Pick<ImpPaths, 'dir'>): Promise<GuestMemory> => {
        const guest = readGuest(paths);

        if (!guest.isSlow) {
          guest.pluggedMib = Math.max(
            guest.requestedMib,
            Math.min(guest.pluggedMib, guest.unplugFloorMib),
          );
        }

        const totalMib = guest.baseMib + guest.pluggedMib;

        return Promise.resolve({
          pluggedMib: guest.pluggedMib,
          requestedMib: guest.requestedMib,
          totalMib,
          availableMib: totalMib - guest.usedMib,
        });
      },
      requestPluggedMib: (paths: Pick<ImpPaths, 'dir'>, mib: number): Promise<void> => {
        readGuest(paths).requestedMib = mib;

        requests.push(mib);

        return Promise.resolve();
      },
    },
  };
}
