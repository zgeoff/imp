# Elastic memory

An imp has a fixed `--memory` by default. Created with `--max-memory`, it is elastic. It boots at
its memory, grows toward its max when it runs low, and gives memory back when it has some to spare.
The guest really has only what it holds. It grows only when impd plugs memory into it, and the RAM
governor must admit every grow first.

```sh
imp new dev --memory 512 --max-memory 2g
imp ls      # MEMORY shows 768/2048 MiB: what the guest holds now, and its max
```

The code is in `packages/daemon/src/memory`. The measurements below are from #35, on a WSL2 dev box
with Firecracker v1.17 and guest kernel 6.1.

## How the guest grows

The mechanism is virtio-mem.

- **The region.** A VM boots with `mem_size_mib` = memory and a hot-plug region
  (`PUT /hotplug/memory`) of max − memory, rounded up to whole 128 MiB slots, in 2 MiB blocks.
- **Onlining.** The boot argument `memhp_default_state=online_movable` onlines plugged memory as
  movable, so that an unplug can migrate pages away. An imp that does not grow has neither the
  region nor the argument.
- **Plug and unplug.** `PATCH /hotplug/memory {"requested_size_mib": N}` asks the guest to hold N
  MiB of the region. The guest plugs blocks or unplugs them in its own time. `GET /hotplug/memory`
  reports `plugged_size_mib`, which is what the guest holds. impd counts the plugged size everywhere
  and never the requested one: an unplug can stop partway. impd sends each request under the imp's
  lifecycle lock, so that a sleep never sees its guest change size.
- **The inner container.** User code runs in the agent's inner container, whose `memory.max` is the
  guest's memory less 64 MiB. In a guest booted with `memhp_default_state`, the agent reads
  `MemTotal` every 250 ms and moves that limit with it, so plugged memory is the user's too. A raise
  goes at once. A cut after an unplug stops at the container's use plus 64 MiB and goes on down as
  the use falls, so a shrink never makes the kernel kill a user process to fit. A plain imp runs no
  such loop and keeps its boot limit. The loop came in agent protocol `0.17.0`. impd grows no guest
  whose agent is older, or whose agent version it has no record of, and logs once that a stop and a
  start updates it: an older agent's container would be OOM-killed in memory the guest grew into.
- **Firecracker.** Memory hot-plug came in Firecracker v1.14.0. impd is tested with v1.17.0, the
  version `host/Dockerfile` pins.
- **Free pages.** The balloon stays at 0 for free page reporting. impd never inflates it, so its
  `deflate_on_oom` has nothing to give back and cannot grow a guest behind the governor's back.

The balloon was the other way to do this, and #35 measured it first. A guest that boots at its max
with an inflated balloon pays the max at every step: 40 MiB of RSS per GiB of max at boot, and a
snapshot as large as the max. virtio-mem pays only for what is plugged.

## Growing

The memory controller ticks every 500 ms over the awake elastic imps. It reads the guest's
`available_memory` from the balloon statistics, which lag by up to 1 s.

- **When.** A guest grows when it has less than the larger of 128 MiB and 15 % of its total
  available. That margin covers a burst of about 100 MiB/s. A faster burst into memory nothing can
  reclaim, such as tmpfs, can outrun it.
- **How much.** It plugs 256 MiB, up to the max. The governor admits the step plus the step's struct
  pages first. The admission works as for a wake: it sleeps idle, unheld imps, least recently active
  first, and refuses when only busy or held imps could make room.
- **Stopped.** A plug that stands still for 2 s has stopped: the guest cannot online more. The guest
  keeps what it plugged, impd asks it for exactly that and lowers the host limit to match, and no
  grow comes for 60 s. impd logs it once, until the guest's size moves again.
- **Refused.** A refused guest stays at its size and gets its own OOM killer. impd logs the refusal
  once per episode. A guest whose only large user is tmpfs has nothing the OOM killer can kill, and
  it panics and stops. The imp is then stopped, and its next use boots it cold.
- **Busy imps.** The controller leaves alone an imp whose lifecycle lock is taken, such as one in
  the middle of a sleep.
- **KSM.** With `IMP_KSM` ([KSM](./sleep-and-wake.md#8-ksm-sharing-identical-guest-pages)), a grow's
  admission counts the KSM headroom, as a boot's or a wake's does, so a split of every merged page
  still fits after it. Firecracker maps the hot-plug region private and anonymous, beside the boot
  memory, so plugged memory carries the merge flag too: a 256 MiB guest grown to 768 MiB showed a
  512 MiB `rw-p` anonymous mapping. `memory.max` follows the plugged size, not what KSM saves, so a
  merged page that splits never passes it.

## Shrinking

- **The spare size.** A shrink unplugs to the least size that leaves the guest a grow step (256 MiB)
  more available than its grow mark: the larger of use + 384 MiB and (use + 256 MiB) / 0.85. A fixed
  headroom would undo itself. Past about 1.7 GiB, 15 % of the guest is more than 256 MiB, so a guest
  shrunk to use + 256 MiB would grow again on the next tick. It never goes below its memory.
- **Idle.** A guest that could give back at least a step for 60 s unplugs to its spare size.
- **A stopped unplug.** An unplug that stands still for 2 s has stopped. The guest keeps what it
  could not give back, impd asks it for exactly that, and no shrink comes for 60 s.
- **Reclaim.** Before the governor sleeps any imp, for a boot, a wake, a grow or enforcement, idle
  elastic imps unplug to their spare size, each for at most 1 s under its lock. The governor then
  measures again. This frees the page cache too, which free page reporting never returns. A guest
  with 600 MiB of page cache went from 663 to 50 MiB of RSS in 190 ms.

## Sleep

Before the pause, a sleep unplugs the guest to its spare size, for at most 2 s under the imp's lock.
It sleeps with whatever the guest holds by then, a plug under way counted at its request. The
snapshot's `meta.json` records `pluggedMib`, the load restores it, and the next ticks grow or shrink
from there.

Firecracker writes only the plugged part of the region. The mem file's size is memory + region, but
an unplugged block is a hole. The disk room a sleep holds is memory + what the guest holds or was
asked to hold, read before the young-guest wait; the shrink only lowers what is written. Measured
with a 256 MiB base and a 1 GiB max, after dropping the page cache each time:

| The guest holds                 | Snapshot create | Written  | dig-holes  |
| ------------------------------- | --------------- | -------- | ---------- |
| 768 MiB plugged, idle           | 773–917 ms      | 1025 MiB | 465–618 ms |
| unplugged first (178–189 ms)    | 225–251 ms      | 256 MiB  | 125–148 ms |
| a plain 256 MiB imp, for scale  | 241 ms          | 256 MiB  | 135 ms     |
| a plain 1024 MiB imp, for scale | 740 ms          | 1025 MiB | 442 ms     |

Plugged memory costs a sleep about 1.2 s per GiB on this box: the write, the page cache it bursts
through, and the dig. An unplugged region costs nothing. At a 4 GiB max with 3 GiB plugged, the
snapshot took 2.3 s and 4.3 GiB of page cache; after an unplug, it took 720 ms.

## What it costs

- **Struct pages.** The guest keeps 64 bytes of `struct page` per 4 KiB page of plugged memory, 16
  MiB per GiB, in its base memory. A grow's admission counts them. Measured: 3 GiB plugged raised
  RSS by 48 MiB, and an unplugged 3 GiB region by nothing.
- **Snapshots.** See [Sleep](#sleep).

## Limits

- **Max is at most 4 × memory.** Movable memory cannot hold the kernel's own allocations: page
  tables, slab, and the struct pages of plugged memory. A guest that is mostly hot-plugged memory
  runs out of kernel memory first. A larger max is refused at create.
- **Max is at most the RAM budget.** The governor admits a boot or a wake by the imp's max, not its
  memory, and never admits an imp whose max is larger than the whole budget. A guest that could grow
  past the budget would make enforcement sleep every other imp on the host. The check runs at each
  boot and wake rather than at create, so that a smaller budget set later holds too. A create boots
  the imp, so it gets the same refusal.
- **Max is fixed.** It is set at create, and a fork, a backup restore and a move keep it. The source
  refuses to move an elastic imp to a target whose impd predates elastic memory: its offer reply has
  no `keepsMaxMemory`, and it would land the imp at a fixed size.
- **Templates.** An elastic imp always boots the kernel, never a
  [boot template](./boot-templates.md). A template's snapshot has no hot-plug region and no
  `memhp_default_state` argument, and a restore cannot add them, so the guest could never grow. Its
  boots count as no miss, so they build no template either.

## Trust

The controller believes the guest's `available_memory`. A guest that reports less than it has gets
grows up to its max without using them, and the governor may sleep idle neighbours to make room.
This stays inside the max and the budget: such a guest gets no more than a guest that really uses
its max.

## The host limit

The host's hard limit on an imp's memory follows what the guest may hold: the cgroup's `memory.max`
([cgroups](./daemon.md#cgroups)) is the guest's memory plus what is plugged, plus the VMM's
overhead. `memory-limit.ts` is the hook, and `main.ts` hands it the cgroups. impd sets it in an
order that never cuts a guest short:

1. a cold boot sets it to memory before the VM starts, a wake that boots cold too;
2. a wake sets it to memory + the snapshot's plugged size before the load;
3. a grow raises it before the plug;
4. a shrink lowers it only once the guest holds no more than the target and its RSS is under the new
   limit;
5. an impd restart's adopt sets it from what the guest holds or was asked to hold, or from the max
   when the guest does not answer, before a sleep or a snapshot can set up the cgroup again.
