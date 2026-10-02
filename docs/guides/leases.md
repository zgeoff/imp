# Leases and holds

A lease keeps an imp awake for as long as a client needs it. The client renews the lease and
releases it, and it never clears a lease that another client holds. impd tells the client when the
RAM budget turns a boot or a wake away, and which awake imps hold that RAM.

`system.info` gives `features.leases: true` on an impd with leases. An impd from before them has no
`features`, and a `leases.*` call to it fails with not-found.

## Owners

A lease belongs to the caller that took it, as impd authenticated it. impd derives a **principal**
for each caller:

| Caller                                                       | Principal                  |
| ------------------------------------------------------------ | -------------------------- |
| A token, a dashboard session made with it, a key bound to it | `token:<token id>`         |
| A key in `authorized_keys`                                   | `key:<SHA256 fingerprint>` |
| A tagged tailnet node                                        | `tailnet:<stable node ID>` |
| A user's tailnet node                                        | `tailnet-user:<login>`     |
| The root token, and a dashboard session made with it         | `root`                     |

A token, its dashboard sessions and its bound keys are one principal, so a lease taken through one
is renewed or released through any of them. A deleted token's id never comes back: a new token with
the same name holds none of the old one's leases. A tagged node whose `tailscale whois` gives no
stable ID is `tailnet:<node name>`.

The caller names only a **label**, 1–64 characters of letters, digits, `.`, `_`, `:` and `-`. The
pair (principal, label) is the lease. The API shows its `owner` as `{ principal, display, label }`;
`display` is the token's name, the key's comment or the node's name.

A caller with host-wide manage (scope `manage`, no imp patterns) sees every owner. Any other caller
sees its own leases in full and only a count of the others. `imps.get`, `imps.list` and every call
that answers with an imp show `leases: { leases, otherCount }` that way. An event shows the count
only: `{ leases: [], otherCount }`.

## Calls

Each call needs `exec` on the imp, as `imp hold` does. `ttlSeconds` is 10–3600.

| Call             | Input                         | Result                     | What it does                                                                                  |
| ---------------- | ----------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `leases.acquire` | `{ name, label, ttlSeconds }` | `{ name, owner, until }`   | Boots or wakes the imp, then creates the caller's lease or moves its end later.               |
| `leases.renew`   | `{ name, label, ttlSeconds }` | `{ name, owner, until }`   | Moves the end of the caller's live lease later. `LEASE_NOT_HELD` otherwise; it wakes nothing. |
| `leases.release` | `{ name, label }`             | `{ released }`             | Deletes the caller's lease only.                                                              |
| `leases.list`    | `{ name?, label? }`           | `{ name, owner, until }[]` | Live leases on the imps the caller reaches, as the caller may see them.                       |

- An acquire or a renew never shortens a lease: the end becomes the later of the old end and now +
  `ttlSeconds`.
- A refused boot fails the acquire with `RAM_BUDGET_EXCEEDED`, and no lease is written.
- A lease ends at its `until`. impd sends no event for that; a renew after it gets `LEASE_NOT_HELD`.
- `acquire` and `release` emit `ImpChanged` with reason `held`. `renew` emits nothing.
- `leases.acquire` and `leases.renew` refuse the label `hold`, which `imp hold` writes and which
  never blocks a sleep.

## Holds

`imp hold <name> <duration>` (`imps.hold`) is the caller's lease with the label `hold`. It writes
the lease before it wakes the imp, so a refused boot keeps the hold, and it has no upper bound.
`imp hold <name> 0` releases the caller's hold and a hold from before leases, and keeps every other
owner's.

impd moved a hold that was live at the upgrade to the owner `legacy`, label `hold`.

`holdUntil` on an imp is the latest end of its live leases, of every kind. The idle loop and the
governor never sleep an imp with a live lease or hold
([sleep and wake](../architecture/sleep-and-wake.md#idle-detection)).

## Sleep and stop

Only a lease taken through `leases.*` blocks a user's sleep or stop. A hold and a legacy hold never
do, and they outlast it.

- `imps.sleep` and `imps.stop` on an imp with a lease from `leases.*` fail with `LEASED`, data
  `{ leases, otherCount }`, shown as [above](#owners).
- With `force: true` they end every such lease on the imp first, and emit `ImpChanged` with reason
  `released` and `detail.released`, the count. A renew after that gets `LEASE_NOT_HELD`.
- `imp sleep` and `imp stop` pass `force`, because a person typed them. The dashboard, the MCP tools
  and older CLIs cannot pass it; they meet `LEASED` only on an imp that a client leased through
  `leases.*`.
- `imps.destroy` ends every lease with the imp.
- impd's shutdown pass still sleeps a leased imp, since stopping the container ends its VM, and
  keeps the leases. The watchdog's restart and a checkpoint restore keep them too.

## Capacity refusals

`RAM_BUDGET_EXCEEDED` keeps `budgetMib`, `usedMib` and `requestedMib`, and adds:

- `neededMib`: what the request lacks past the budget;
- `protected`: `{ name, ramMib, leased, busy }[]`, the awake imps the governor could not sleep that
  the caller may read. `leased` is any live lease or hold; `busy` is an imp in use, under a
  lifecycle operation, or whose sleep failed;
- `protectedHidden`: how many others there were.

The same filter applies over `/exec`. A `GovernorDecision` `refused` event adds `neededMib` and
`protectedCount`, never the names.

## Compatibility

| Case                              | Result                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| An old CLI, dashboard or MCP tool | Old shapes. `released` reaches it as an unknown reason. A held imp sleeps as before. |
| An old `imp hold`                 | The caller's `hold` lease; `hold 0` also releases `legacy`.                          |
| A new client and an old impd      | No `features`; `leases.*` fails with not-found; no `leases` on an imp.               |

## Limits

- A lease with no end (a null `until`) counts as held for good. No call writes one.
- Leases end by time only; impd sends no event when one runs out.
- The store is `imp_leases` in impd's database: one row per (imp, principal, label), deleted with
  the imp.
