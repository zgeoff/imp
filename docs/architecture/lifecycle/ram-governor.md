# The RAM governor

The governor keeps the RAM of every awake imp under one budget, which the owner sets for the host.
Imps share the host with everything else on it, and a host that runs out of RAM kills processes at
random, so the budget is a hard line the governor holds. It admits every boot, wake and memory grow
before it happens, and sleeps the least recently active imps to make room. The
[lifecycle](./lifecycle.md) asks it for room under the imp's lock;
[elastic memory](./elastic-memory.md) covers the grows it admits.

## What it measures

The governor counts what each Firecracker owns: the anonymous and shared pages of its proportional
set size, from the kernel's per-process memory summary. It leaves out clean file pages on purpose. A
woken guest maps its memory file privately, so the pages it has only read are clean pages of that
file, which the host can drop and read again. A guest restored from a
[boot template](./boot-templates.md#ram) shares its template's file the same way. Counting those
pages would charge each woken imp for memory the host can take back at any time.

To answer for one VM, the kernel walks every page that VM maps, which takes longer the more memory
the guest uses. The governor therefore reads every awake VM's summary at once, off impd's event
loop. One read after another would hold every other request until the last read ended.

A VM that just booted or woke measures small for some seconds while it faults its pages in. So each
admission also leaves a reservation: a share of the memory for a cold boot, and for a wake the
larger of what the VM owned at its sleep and a floor. A reservation counts until the measurement
passes it, or for a bounded time.

## Admission

One admission runs at a time, under the governor's own lock. When the new imp's reservation fits
beside what is measured and reserved, it is admitted. When it does not:

1. Idle elastic guests give back the memory they can spare, which costs no imp its memory, and the
   governor measures again.
2. It picks the least recently active imp that it may sleep, and sleeps it, then measures and picks
   again. An imp is never a victim while it is held, has its lock taken, or has an open exec,
   proxied request, SSH connection or tunnel.
3. It sleeps one victim at a time, because after a skip or a failure the rest of a pick is stale,
   and sleeping it could cost imps their memory for an admission that then gives up.

The governor never waits for a victim's lock: it holds admission, and a boot that waits on admission
may hold another imp's lock. A victim locked by the time its turn comes is skipped, as is one whose
sleep fails or whose snapshot the disk cannot take. When the imps it may sleep could not free enough
even all together, the request fails with `RAM_BUDGET_EXCEEDED` at once, before it sleeps any of
them, and the error names the awake imps it could not sleep. An imp whose own memory is larger than
the whole budget is never admitted. A refusal that comes later, once a skip or a failure leaves the
rest short, still costs the sleeps done before it, and each of those imps wakes on its next request.
A caller of the wake proxy gets a 503 for a refusal; an API caller gets the error.

Work no caller waits on, such as a boot template's build, is admitted only into free room, never by
sleeping an imp.

## Enforcement

A guest can grow past its reservation, so measured use can pass the budget between admissions. On a
short tick, the governor sleeps least recently active imps while measured use is over the budget,
regardless of the idle timeout. When the imps it may sleep cannot bring use under the budget, it
sleeps all of them, to get as close as it can. This trades availability for the host: an imp that
served a request a moment ago can go to sleep. While use stays over, every boot and wake fails with
`RAM_BUDGET_EXCEEDED`, so an imp the governor slept does not wake only to sleep again.

Each decision goes on the event bus as a `GovernorDecision`, with the imps it slept and why.

## KSM

Kernel samepage merging lets the host keep one copy of a page that several guests hold. It is off by
default, and the owner turns it on for the whole host.

**CAUTION:** merged pages let one guest learn about another. A write to a merged page is slower,
because the kernel copies it first, so a guest can time its writes to learn which pages another
guest holds, and shared pages are a Rowhammer target. Imps run agent code that a prompt injection
can take over, so KSM is a trade the owner of a single-owner host accepts. The jailer does not
change it: the kernel merges physical pages whatever process, uid or namespace maps them.

Firecracker has no KSM setting, and its seccomp filter traps the call that would set one. So impd
starts each VM through a small launcher that marks the process's memory mergeable and execs the
jailer in place. The mark belongs to the process's memory and survives each exec. That needs Linux
6.10 or later, where the kernel scans an exec'd process, and impd refuses to start with KSM on an
older kernel. After each boot, wake and adopt it checks the mark, and reports a VM that lost it.

A merged page's share splits across the VMs that map it, so measured use falls by what KSM saves
with no change to the governor. A write splits a merged page again at write speed, faster than an
enforcement tick, so the governor keeps a headroom of what KSM saves free beside the budget. At the
full headroom, a split of every merged page at once still fits, and KSM lowers the host's real RAM
use without fitting more imps; a smaller headroom fits more imps and takes the risk. A sleep then
records a VM's unshared size, not its shared one, for the next wake's reservation.
