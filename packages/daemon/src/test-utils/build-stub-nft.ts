import type { NftRunner } from '../egress/egress-firewall';

interface Refusal {
  readonly reason: string;
  readonly match: (script: string) => boolean;
  left: number;
}

interface Hold {
  readonly match: (script: string) => boolean;
  readonly reached: PromiseWithResolvers<string>;
  readonly released: PromiseWithResolvers<void>;
}

interface RefuseOptions {
  // nft's first line of stderr, as runNft reports it
  readonly reason: string;

  // the scripts refused; every one by default
  readonly match?: (script: string) => boolean;

  // how many it refuses before it takes them again; no end by default
  readonly times?: number;
}

// `nft -f -` in memory. A script is one transaction: one it takes is
// recorded whole; one it refuses rejects as runNft does and changes nothing.
// A test picks each fault itself.
export function buildStubNft() {
  const scripts: string[] = [];
  const refusals: Refusal[] = [];
  const holds: Hold[] = [];

  const runNft: NftRunner = async (script) => {
    const hold = holds.find((each) => each.match(script));

    if (hold !== undefined) {
      holds.splice(holds.indexOf(hold), 1);
      hold.reached.resolve(script);

      await hold.released.promise;
    }

    const refusal = refusals.find((each) => each.left > 0 && each.match(script));

    if (refusal !== undefined) {
      refusal.left -= 1;
      throw new Error(`nft exited 1: ${refusal.reason}`);
    }

    scripts.push(script);
  };

  return {
    runNft,

    // every script nft took, in order
    scripts: scripts as readonly string[],

    // the last whole table nft took, or null before the first
    readTable: (): string | null =>
      scripts.findLast((script) => script.startsWith('table inet imp_egress {}\n')) ?? null,

    refuse: (options: Readonly<RefuseOptions>): void => {
      refusals.push({
        reason: options.reason,
        match: options.match ?? (() => true),
        left: options.times ?? Number.POSITIVE_INFINITY,
      });
    },

    // takes every script again
    accept: (): void => {
      refusals.length = 0;
    },

    // the next script `match` picks waits, before nft takes or refuses it,
    // until the test releases it; `reached` resolves with that script
    hold: (match: (script: string) => boolean) => {
      const hold: Hold = {
        match,
        reached: Promise.withResolvers<string>(),
        released: Promise.withResolvers<void>(),
      };

      holds.push(hold);

      return {
        reached: hold.reached.promise,
        release: (): void => {
          hold.released.resolve();
        },
      };
    },
  };
}
