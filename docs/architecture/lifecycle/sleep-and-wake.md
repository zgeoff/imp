# Sleep and wake

A sleep writes an imp's whole memory to a snapshot on disk and ends its Firecracker process, so the
imp holds no RAM. A wake starts a new Firecracker that loads the snapshot, and the guest goes on
with every process where it was. The idle loop decides when an imp sleeps, the
[RAM governor](./ram-governor.md) may sleep one sooner to make room, and the
[lifecycle](./lifecycle.md) runs both under the imp's lock.

## Sleep

A snapshot is a pair of files, the VM state and the memory file, and one small record, `meta.json`,
that commits them. Without the record the files never load, even after a power loss, so the record
is the only thing a crash has to get right.

1. Under the imp's lock, impd first holds room on the disk for the whole memory, since the memory
   file is written at full size before its zero pages become holes. When the disk cannot take it,
   the imp stays awake and the sleep fails with `DISK_FULL`
   ([disk space](../storage/disk-space.md)).
2. An elastic guest gives back the memory it can spare, so the snapshot is smaller
   ([elastic memory](./elastic-memory.md#sleep)). impd reads the guest's sessions and services one
   last time, for the listings of a sleeping imp ([sessions](../guest/sessions.md)).
3. impd deletes the old `meta.json`, so no crash from here on can pair the old record with new
   files.
4. It waits for one of the host's sleep slots. A snapshot pushes the whole memory file through the
   host's page cache, and a few at a time keep a burst of sleeps from flooding it.
5. It pauses the VM and has Firecracker write a full snapshot into new files. A failure here deletes
   the new files and resumes the VM, and the imp stays awake.
6. It kills Firecracker. The VM is paused and its state is on disk, so nothing needs a clean
   shutdown.
7. It renames the new files over the old ones, digs holes in the memory file where the guest's pages
   are zero, flushes the files and their directory, and writes `meta.json`, flushed and renamed into
   place. Last, it sets the imp's row to `sleeping`, a separate write that a crash can still miss
   ([recovery](./lifecycle.md#recovery-after-a-restart)).

impd never writes into a memory file a VM has mapped. A woken VM maps its memory file privately and
faults pages in from it, so the next sleep always writes new files and renames them over.

The tap stays across a sleep, because the snapshot names it, and a container restart, which removes
every tap, makes it again before the next wake.

## Wake

1. impd reads `meta.json` and checks the snapshot against this host
   ([snapshot identity](#snapshot-identity)). With no snapshot, or one this host cannot load, the
   wake boots the disk cold instead.
2. It sets up the imp's cgroup and asks the governor for room: the larger of what the VM owned at
   its sleep and a floor for a fresh wake. A wake the budget turns away keeps the imp asleep with
   its snapshot.
3. It renames `meta.json` to `meta.json.loading`. From here the guest may run and write its disk, so
   after a crash this snapshot must never load again.
4. It makes the tap if it is gone, starts Firecracker in the jail, and loads the snapshot as the
   first API call, paused. It seals the jail, so no guest code runs while the VM can still change
   its files ([isolation](../isolation.md#the-jailer)), and resumes the VM.
5. It pings the agent, and sends it the host's clock. Without that, the guest clock stays behind by
   the time asleep: the guest's clocksource keeps counting from where the snapshot stopped.
6. It sets the state to `running` and deletes `meta.json.loading`.

If the load, the jail's seal or the agent fails, impd kills the new VM, drops the snapshot and boots
the disk cold. The guest may have run and written its disk, so the snapshot no longer matches it.
The disk is always the truth, and a lost memory is the cost.

A crash during a wake leaves `meta.json.loading`, and the next impd settles it. It asks each
Firecracker it finds over its API whether the VM started; a VM that never loaded is killed and the
record goes back to `meta.json`, so the snapshot stays. A VM that loaded gets the rest of the wake,
and is killed with its snapshot dropped if any step fails. With no VM left, the snapshot is dropped
and the imp boots cold. One window loses memory it need not: impd dying after the rename and before
Firecracker starts drops a snapshot no guest ran.

## Snapshot identity

A snapshot loads only on the software and hardware it was made on. A cold boot records what its VM
booted with, `vm.json`: the Firecracker version and snapshot format, the host kernel, the hashes of
the guest kernel and the system drive, the drive's path, the CPU model and a hash of its flags, and
the agent's protocol version. Each sleep copies that into `meta.json`. A wake boots cold when the
Firecracker version, the snapshot format, the host kernel or the CPU changed. The CPU matters
because the guest kernel picked its code paths from the CPU's flags at boot, and a snapshot loaded
on a CPU without one of them faults later, not at the load. That covers a cloud host whose CPU
changes at a reboot, and a move to another machine.

A new guest kernel does not force a cold boot, because the snapshot holds the kernel in memory. The
snapshot reopens the system drive by path, so impd keeps every drive file a snapshot names
([storage](../storage/storage.md#system-files)). A jailed wake binds the drive the snapshot names
into the jail, not the drive the host boots now, so after an agent upgrade the load reopens the
older drive, as an unjailed wake does in place. After the load the agent must answer with the
protocol version the snapshot recorded, or the VM is not the one that slept, and impd boots cold. So
a woken imp runs its old agent and kernel until its next cold boot.

## What survives a sleep

Everything in the guest's memory survives: processes, tmpfs contents and
[sessions](../guest/sessions.md). TCP connections reset, since the peer saw no answer while the
guest slept. On a resume the guest closes every vsock connection, so a plain exec loses its host
side, gets SIGHUP and stops counting as a session. A session only loses its client, which can attach
again.

## Idle detection

The idle loop looks at every running imp on a short tick. An imp is active while it has any of
these:

- a host-side connection: an exec or attached console, a proxied request, an SSH connection or a
  tunnel ([the lifecycle](./lifecycle.md#what-keeps-an-imp-awake));
- an established TCP connection in the guest, from the agent's activity report, loopback aside;
- Firecracker CPU above a threshold of one core, against the near-zero an idle guest uses;
- a live lease or hold.

An imp with none of these for the idle timeout goes to sleep, unless it turned active or held by the
time the sleep takes its lock. A coding agent that waits on a model API keeps its connection open,
so it stays awake. A detached session counts only through its CPU and its connections.

## Young guests

A host kernel before Linux 6.7 wakes a guest slowly when its snapshot was taken less than about a
second after the VM started. At the restore, KVM keeps the start-time TSC offset for a TSC written
that soon, the guest clock stands still until the TSC catches up, and the wake takes as long as the
guest's age at the snapshot. Upstream fixed it in 6.7 (bf328e22e472). So a user's sleep or impd's
stop waits until the guest is old enough, and gives way if the imp turns busy meanwhile. A governor
sleep never waits, because it holds admission while a boot waits on it, so its victim's next wake
may be slow. An idle sleep never meets a guest that young.
