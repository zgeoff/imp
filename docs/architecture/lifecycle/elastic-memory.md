# Elastic memory

An imp has a fixed memory size by default. An elastic imp, created with a max memory, boots at its
memory size and grows toward its max when it runs low, then gives memory back when it has some to
spare. The guest holds only what impd has plugged into it, and the [RAM governor](./ram-governor.md)
admits every grow first, so an elastic imp never takes RAM behind the budget's back.

## How the guest grows

The mechanism is virtio-mem. A VM boots with its memory size plus a hot-plug region up to its max,
and the guest kernel onlines plugged memory as movable, so that an unplug can migrate pages away.
impd asks Firecracker for a plugged size, and the guest plugs or unplugs blocks in its own time.
impd counts the plugged size, never the requested one, because an unplug can stop partway. It sends
each request under the imp's lock, so a sleep never sees its guest change size.

The balloon was the other way to do this. A guest that boots at its max with an inflated balloon
pays the max at every step, in RSS at boot and in a snapshot as large as the max, where virtio-mem
pays only for what is plugged. Every VM keeps a balloon at zero for free page reporting, which
returns freed guest pages to the host, and impd never inflates it.

User code runs in the agent's inner container, whose memory limit follows the guest's memory. In an
elastic guest the agent moves that limit as memory comes and goes, so plugged memory is the user's
too. A cut after an unplug stops at the container's use plus a margin and goes on down as the use
falls, so a shrink never makes the kernel kill a user process to fit. impd grows no guest whose
agent is too old to move its limit, because that container would be killed in memory the guest grew
into.

## The controller

The memory controller ticks over the awake elastic imps and reads each guest's available memory from
the balloon's statistics.

- **Grow.** A guest that runs low plugs one step more, up to its max. The governor admits the step
  and the guest's page structures for it, as it admits a wake, and may sleep idle imps to make room.
  A grow it refuses leaves the guest at its size, with its own OOM killer.
- **Shrink.** A guest that could give back a step for a while unplugs to its spare size: the least
  size that leaves it a grow step clear of its grow mark. A fixed headroom would undo itself,
  because in a large guest the grow mark passes it and the next tick would grow the guest again.
- **Stalls.** A plug or an unplug that stands still has stopped: the guest keeps what it reached,
  impd asks for exactly that, and the controller leaves the imp alone for a while.
- **Reclaim.** Before the governor sleeps any imp, idle elastic guests unplug to their spare size.
  That frees their page cache too, which free page reporting never returns.

The controller leaves alone an imp whose lock is taken, and trusts the guest's report. A guest that
reports less than it has gets grows it does not use, and the governor may sleep idle neighbours for
them, but never past its max or the budget.

## The host limit

The cgroup's hard limit on a VM follows what its guest may hold: its memory, plus what is plugged,
plus room for Firecracker and its page cache. impd moves the limit in an order that never cuts a
guest short. A cold boot sets it to the memory alone, a wake to the memory plus the snapshot's
plugged size before the load, a grow raises it before the plug, and a shrink lowers it only once the
guest holds no more than the target. An impd restart sets it from what each adopted guest holds.

## Sleep

Before the pause, a sleep unplugs the guest to its spare size, briefly and under the imp's lock.
Firecracker writes only the plugged part of the region, so an unplugged region costs a snapshot
nothing, and plugged memory costs it the write. The snapshot records the plugged size, the load
restores it, and the controller goes on from there.

## Limits

- **The max is a few times the memory at most.** Movable memory cannot hold the kernel's own
  allocations, such as page tables, slab and the page structures of plugged memory, so a guest that
  is mostly plugged memory runs out of kernel memory first. A larger max is refused at create.
- **The max is within the budget.** The governor admits a boot or a wake by the imp's max, and never
  admits an imp whose max is larger than the whole budget, because a guest that could grow past the
  budget would make enforcement sleep every other imp. The check runs at each boot and wake, so a
  smaller budget set later holds too.
- **The max is fixed.** A fork, a backup restore and a move keep it. A move refuses a target that
  cannot keep it, rather than land the imp at a fixed size.
- **No boot templates.** A template's snapshot has no hot-plug region, and a restore cannot add one,
  so an elastic imp always boots its kernel ([boot templates](./boot-templates.md)).
