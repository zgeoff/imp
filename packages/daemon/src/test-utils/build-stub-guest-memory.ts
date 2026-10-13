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

  // the plugged sizes the next reads find, in order, as a guest that moves
  // between them; once empty, the guest moves as `isSlow` says
  pluggedOnReads: readonly number[];

  // true: a request lands, but its answer never comes back, as when
  // Firecracker applies it after impd's wait for the answer ran out
  isAnswerLost: boolean;

  // how many reads after each request get no answer, as from a VM whose API
  // is still busy with that request
  lostReadsAfterRequest: number;

  // the balloon statistics a read reports while they lag the guest, as
  // Firecracker's do between polls; null reports the guest as it is now
  staleStats: { readonly totalMib: number; readonly availableMib: number } | null;
}

// virtio-mem plugs and unplugs whole 2 MiB blocks
const BLOCK_MIB = 2;

// The virtio-mem devices of running guests, keyed by imp dir. A read finds a
// plug or unplug done, down to the floor, unless the guest is slow or scripted;
// a call for a VM it does not hold rejects, as the runner's does for one gone.
export function buildStubGuestMemory() {
  const guests = new Map<string, StubGuest>();

  const requests: number[] = [];

  // reads still to reject, per imp dir, since the last request
  const lostReads = new Map<string, number>();

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
        pluggedOnReads: [],
        isAnswerLost: false,
        lostReadsAfterRequest: 0,
        staleStats: null,
        ...guest,
      };

      guests.set(paths.dir, added);

      return added;
    },
    vms: {
      readGuestMemory: async (paths: Pick<ImpPaths, 'dir'>): Promise<GuestMemory> => {
        const guest = await readGuest(paths);

        const lost = lostReads.get(paths.dir) ?? 0;

        if (lost > 0) {
          lostReads.set(paths.dir, lost - 1);
          throw new Error('firecracker GET /hotplug/memory: no answer within 1000 ms');
        }

        const [scriptedMib, ...laterMib] = guest.pluggedOnReads;

        guest.pluggedOnReads = laterMib;

        if (scriptedMib !== undefined) {
          guest.pluggedMib = scriptedMib;
        } else if (!guest.isSlow) {
          guest.pluggedMib = Math.max(
            guest.requestedMib,
            Math.min(guest.pluggedMib, guest.unplugFloorMib),
          );
        }

        const totalMib = guest.baseMib + guest.pluggedMib;

        return {
          pluggedMib: guest.pluggedMib,
          requestedMib: guest.requestedMib,
          ...(guest.staleStats ?? { totalMib, availableMib: totalMib - guest.usedMib }),
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
        lostReads.set(paths.dir, guest.lostReadsAfterRequest);

        if (guest.isAnswerLost) {
          throw new Error('firecracker PATCH /hotplug/memory: no answer within 1000 ms');
        }
      },
    },
  };
}
