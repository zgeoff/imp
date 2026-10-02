// What the resolver let into each box slot's set, and until when. impd
// keeps the expiry itself and a sweep deletes what is due: nftables does not
// refresh an element's timeout on a second add before kernel 6.10.

export interface AddressAnswer {
  readonly address: string;
  readonly ttlS: number;
}

export interface SetLimits {
  // the clamp on an answer's TTL: short TTLs would churn the set, long ones
  // keep a moved name's old address allowed
  readonly minTtlS: number;
  readonly maxTtlS: number;
  readonly maxPerSlot: number;
}

interface SetChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface EgressSets {
  // The answers to a query for an allowed name. `names` is the name asked for
  // and the CNAME chain from it; the chain's names become allowed aliases.
  readonly record: (
    slot: number,
    names: readonly string[],
    answers: readonly AddressAnswer[],
    now: number,
  ) => SetChange;
  readonly isAlias: (slot: number, name: string, now: number) => boolean;

  // drops what expired, per slot
  readonly sweep: (now: number) => ReadonlyMap<number, readonly string[]>;

  // keeps the addresses some name of which `keep` still allows; aliases go
  readonly prune: (slot: number, keep: (name: string) => boolean) => readonly string[];
  readonly clear: (slot: number) => void;
  readonly listAddresses: (slot: number) => readonly string[];

  // what the slot's set holds, each address with its names and the seconds
  // it has left: what a warm move carries to the target
  readonly listAnswers: (slot: number, now: number) => readonly HeldAnswer[];
}

export interface HeldAnswer {
  readonly names: readonly string[];
  readonly address: string;
  readonly ttlS: number;
}

interface Entry {
  expiresAt: number;
  readonly names: Set<string>;
}

export function createEgressSets(limits: SetLimits): EgressSets {
  const entries = new Map<number, Map<string, Entry>>();
  const aliases = new Map<number, Map<string, number>>();

  const toExpiryMs = (ttlS: number): number =>
    Math.min(Math.max(ttlS, limits.minTtlS), limits.maxTtlS) * 1000;

  return {
    record: (slot, names, answers, now) => {
      const slotEntries = entries.get(slot) ?? new Map<string, Entry>();
      const slotAliases = aliases.get(slot) ?? new Map<string, number>();

      entries.set(slot, slotEntries);
      aliases.set(slot, slotAliases);

      const added: string[] = [];

      const touched = new Set<string>();

      const longest = Math.max(0, ...answers.map((answer) => answer.ttlS));

      for (const alias of names.slice(1)) {
        const until = now + toExpiryMs(longest);

        slotAliases.set(alias, Math.max(slotAliases.get(alias) ?? 0, until));
      }

      for (const answer of answers) {
        const expiresAt = now + toExpiryMs(answer.ttlS);
        const entry = slotEntries.get(answer.address);

        touched.add(answer.address);

        if (entry === undefined) {
          slotEntries.set(answer.address, { expiresAt, names: new Set(names) });
          added.push(answer.address);
        } else {
          entry.expiresAt = Math.max(entry.expiresAt, expiresAt);

          for (const name of names) {
            entry.names.add(name);
          }
        }
      }

      // a full set drops what expires soonest, never this answer
      const removed = [...slotEntries]
        .filter(([address]) => !touched.has(address))
        .toSorted(([, a], [, b]) => a.expiresAt - b.expiresAt)
        .slice(0, Math.max(0, slotEntries.size - limits.maxPerSlot))
        .map(([address]) => address);

      for (const address of removed) {
        slotEntries.delete(address);
      }

      return { added, removed };
    },

    isAlias: (slot, name, now) => (aliases.get(slot)?.get(name) ?? 0) > now,

    sweep: (now) => {
      const due = new Map<number, readonly string[]>();

      for (const [slot, slotEntries] of entries) {
        const expired = [...slotEntries]
          .filter(([, entry]) => entry.expiresAt <= now)
          .map(([address]) => address);

        for (const address of expired) {
          slotEntries.delete(address);
        }

        if (expired.length > 0) {
          due.set(slot, expired);
        }
      }

      for (const slotAliases of aliases.values()) {
        for (const [alias, until] of slotAliases) {
          if (until <= now) {
            slotAliases.delete(alias);
          }
        }
      }

      return due;
    },

    prune: (slot, keep) => {
      const slotEntries = entries.get(slot);

      aliases.delete(slot);

      if (slotEntries === undefined) {
        return [];
      }

      const removed = [...slotEntries]
        .filter(([, entry]) => ![...entry.names].some((name) => keep(name)))
        .map(([address]) => address);

      for (const address of removed) {
        slotEntries.delete(address);
      }

      return removed;
    },

    clear: (slot) => {
      entries.delete(slot);
      aliases.delete(slot);
    },

    listAddresses: (slot) => [...(entries.get(slot)?.keys() ?? [])],

    listAnswers: (slot, now) =>
      [...(entries.get(slot) ?? [])]
        .filter(([, entry]) => entry.expiresAt > now)
        .map(([address, entry]) => ({
          names: [...entry.names],
          address,
          ttlS: Math.ceil((entry.expiresAt - now) / 1000),
        })),
  };
}
