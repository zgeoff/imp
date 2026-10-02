// What each awake elastic guest holds plugged, for the API. The memory
// controller writes it every tick, and a sleep and a wake when they change it.
export interface PluggedSizes {
  readonly read: (impId: string) => number | undefined;

  // null once impd no longer knows, as after a sleep or a stop
  readonly write: (impId: string, mib: number | null) => void;
}

export function createPluggedSizes(): PluggedSizes {
  const sizes = new Map<string, number>();

  return {
    read: (impId) => sizes.get(impId),
    write: (impId, mib) => {
      if (mib === null) {
        sizes.delete(impId);
      } else {
        sizes.set(impId, mib);
      }
    },
  };
}
