# Sleep and wake

An idle imp goes to sleep: impd writes its memory to disk, stops its Firecracker process and gives
the RAM back to the host. A request, an `exec` or a `console` wakes it in about 50–100 ms, with
every process where it was. This page describes what impd does, then the prototype findings the
design rests on.

## Sleep

Every VM gets a balloon before `InstanceStart`:
`{"amount_mib":0,"deflate_on_oom":true,"stats_polling_interval_s":1,"free_page_reporting":true}`.
With free page reporting, memory the guest frees goes back to the host in about 15 s, and the next
snapshot is smaller.

To sleep an imp, impd takes the imp's lock and first checks the disk can take the snapshot
([disk full](#disk-full)). For `imp sleep` and impd's stop, if the guest has been up for less than
`IMP_SLEEP_MIN_GUEST_UPTIME_MS` (default 1500), impd waits for the rest
([young guests](#young-guests)). It reads the RAM the VM owns now, for the next wake's reservation,
and deletes `meta.json`, so no crash from here on can pair the old record with new files. Then it
waits for a slot of a host-wide semaphore (2 sleeps at a time, [gotcha 8](#4-gotchas)) and:

1. Pauses the VM (`PATCH /vm`).
2. Writes a full snapshot to `vmstate.new` and `mem.new` (`PUT /snapshot/create`). If the pause or
   the snapshot fails, impd deletes the `.new` files and resumes the VM; the imp stays awake. If the
   resume fails too, it kills the VM, and the imp boots cold next time.
3. Kills Firecracker with SIGKILL and waits for it to exit. The VM is paused and its snapshot is on
   disk, so nothing needs a clean shutdown.
4. Renames the `.new` files over `vmstate` and `mem`. It never writes into the old mem file: a woken
   VM maps it `MAP_PRIVATE` ([gotcha 3](#4-gotchas)).
5. Deletes `api.sock` and `vsock.sock`, and runs `fallocate --dig-holes` on the mem file. A 2 GiB
   file with 300 MiB in use becomes 381 MiB. A failure here only costs disk.
6. Flushes `vmstate`, `mem` and the directory to the disk, then writes `meta.json`, flushed and
   renamed into place, and sets the state to `sleeping`. The tap stays. `meta.json` is the
   snapshot's commit record: without it the files never load, even after a power loss.

If Firecracker is gone after a failed sleep, impd drops the snapshot and marks the imp `stopped`.

Every Firecracker API call gives up after 10 s, and snapshot create and load after 120 s. A wedged
VM then fails the sleep, instead of holding the imp's lock for good.

### Background sleeps

The idle loop and the governor decide from a record they read earlier, so the sleep checks again
under the imp's lock. Both skip an imp with a hold, an open exec session, a proxied connection, an
SSH connection or a tunnel. The idle loop also skips an imp that was active since it looked. The
governor does not: it sleeps the least recently active imp, idle or not.

Neither waits for an imp's lock. If the lock is taken, the sleep is skipped. The governor holds its
admission lock while it sleeps, and a boot under the imp's lock may be waiting for admission, so
waiting would deadlock. The type of the governor's sleep admits only a try-lock.

The governor does not wait for a young guest: it holds admission, and the boot that waits on it
matters more than a slow wake later. An idle sleep would wait, but an imp idle for
`IMP_IDLE_TIMEOUT_S` is never that young. If it were, the wait reads the imp's record again as it
goes and gives way when the imp turns busy or held, or a request arrives: the imp stays awake and
the sleep counts as skipped.

### Disk full

A snapshot writes the whole guest memory before `fallocate --dig-holes` shrinks it. So a sleep first
holds the imp's memory in the [disk budget](./storage.md#disk-budget), before the young-guest wait
and the pause. When the hold would cut into `IMP_DISK_RESERVE_GIB`, impd does not pause the VM: the
imp stays awake and `imp sleep` fails with `DISK_FULL`. The idle loop and the governor move on to
other imps; an admission the disk keeps from making room fails with that `DISK_FULL` instead of
`RAM_BUDGET_EXCEEDED`. A wake still goes through, so a full disk never strands an imp's work.

## Wake

1. impd reads `meta.json` and checks it against this host ([snapshot identity](#snapshot-identity)).
   On no snapshot or a snapshot that cannot load, it boots the disk cold instead.
2. It reserves RAM: the larger of what the VM owned at sleep and `IMP_WAKE_RESERVE_MIB`.
3. It creates the tap if it is gone (a container restart removes taps).
4. It renames `meta.json` to `meta.json.loading`: from here the guest may run and write its disk, so
   after a crash the snapshot must not load again. It starts Firecracker, which first removes a
   stale `vsock.sock` ([gotcha 1](#4-gotchas)), and makes `PUT /snapshot/load` with
   `resume_vm: true` the first API call.
5. It pings the agent for up to 10 s, then sends `resumed` with the host time. Without it the guest
   clock is behind by the time asleep.
6. It sets the state to `running` and deletes `meta.json.loading`: the VM now runs on that memory.
   Pages then fault in lazily from the mem file.

If the load or the agent fails, impd kills the new Firecracker, drops the snapshot and boots the
disk cold. The loaded guest may have written the disk, so the snapshot no longer matches it. The imp
counts as stopped until the cold boot succeeds. The disk is always the truth.

Snapshot files stay until the next sleep renames over them, a stop, a restore, a failed wake or a
cold boot. A cold boot removes them only once the governor admits it. A sleeping imp whose snapshot
was never loaded, such as one from another Firecracker, keeps its memory when the budget turns its
cold boot away.

### Snapshot identity

A cold boot writes `vm.json` in the imp's directory: what the VM booted with. It holds the
Firecracker version, the snapshot format, the host kernel (`uname -r`), the sha256 of the guest
kernel and of the system drive, the drive's path, the CPU, the agent's protocol version from its
first `ping`, and why the boot was cold when it replaced a wake (the next sleep clears that). It is
written next to the old file and renamed over it; a failed write is logged and the boot goes on. The
file stays through sleeps, wakes and impd restarts, so a re-adopted VM that booted on an older drive
still says so. Each sleep copies it into `meta.json`, with the imp's memory size and the RAM the VM
owned at sleep.

A wake loads the snapshot only when all of these hold. Otherwise it boots the disk cold:

| What changed since the VM booted | Wake                                                  |
| -------------------------------- | ----------------------------------------------------- |
| The Firecracker version          | cold boot                                             |
| The snapshot format              | cold boot                                             |
| The host kernel                  | cold boot                                             |
| The CPU model or its flags       | cold boot ([the CPU](#the-cpu))                       |
| The system drive (the agent)     | restores while the drive file is kept, else cold boot |
| The guest kernel                 | restores: the snapshot holds the kernel in memory     |
| `meta.json` without a drive path | cold boot: the snapshot is from an older impd         |

The snapshot reopens the system drive by path, and its page cache holds blocks of those bytes, so
impd keeps every drive a snapshot names ([storage](./storage.md#system-files)). After a load, the
agent must answer with the protocol version `meta.json` recorded; anything else is not the VM that
went to sleep, and impd boots cold.

#### The CPU

The guest kernel picks its code paths from the CPUID flags at boot, and a loaded snapshot keeps
them. On a CPU without one of those features the guest faults later, not at the load. So `vm.json`
records the first processor's `model name` and a sha256 of its sorted `flags` from `/proc/cpuinfo`
(`CPU part` and `Features` on arm64), and a wake on another model or other flags boots cold. That
covers a cloud host whose CPU changes at a reboot, and a [move](./moves.md) to another machine. A
snapshot from an impd before this has no CPU and loads as before.

A woken imp keeps its old agent and kernel until its next cold boot (`imp stop`, then `imp start`).
`imp ls` shows both cases in its NOTE column ([operations](../guides/operations.md#upgrade)).

## What survives a sleep

- In-memory processes, tmpfs contents and everything else in RAM survive.
- TCP connections reset.
- On wake the guest closes every vsock connection. An exec whose host side hangs up gets SIGHUP and
  is detached after 1 s, so it does not keep the imp awake.
- [Sessions](./daemon.md#sessions-detachable-consoles) survive: they live in guest memory, and a
  vsock reset only detaches their client. An imp with a client attached does not go to sleep on its
  own; an explicit `imp sleep` or impd's stop detaches the client with `lost`, and it can attach
  again after the wake.

Anything that needs a VM wakes a sleeping imp and cold-boots a stopped one: `exec`, `console`, the
proxy, an SSH login, an `imp proxy` connection, `start`, `wake` and `hold`. `stop` frees the memory;
it does not keep the imp off.

## Restarts

- On SIGTERM or SIGINT, impd sleeps every awake imp, so a container restart keeps memory. It takes
  each imp's lock in turn, so a wake or boot under way finishes first and that imp is put to sleep
  too. Once this pass starts, no VM boots or wakes: those calls fail with `SERVICE_UNAVAILABLE`, and
  a create cut short goes to `error`.
- On SIGHUP, impd sleeps nothing, but it waits for any wake or boot under way, so none leaves a
  Firecracker that no record knows. Firecracker processes are detached (`setsid`), so the next impd
  re-adopts every live VM by pid and API socket, even one whose agent answers late.
- The whole stop has one deadline of 100 s, under the 120 s that `scripts/dev.sh down` gives it.
  Each step before the sleep pass gets at most 10 s; the sleep pass gets the rest. Open exec
  sessions close with code 1012 first. If the last step runs out of time, impd exits without closing
  the database, since a sleep may still write to it.
- After a crash, an imp with no live VM is marked `stopped` and boots cold. One exception: if the
  snapshot on disk is newer than the imp's last activity, impd stopped between a sleep's snapshot
  and its record, so the imp is marked `sleeping` and keeps its memory. Sleeping imps stay asleep
  and wake on demand.
- On start, impd finds every Firecracker on each imp's exact API socket, by its pid file and in
  `/proc` (a start killed before the pid file leaves none), and settles it under the imp's lock:
  - A VM its record does not own is killed: a second one on a running imp's socket, one on a stopped
    imp's, or one on the socket of an imp with no record.
  - A running imp's VM that a cut sleep left paused (`GET /` says `Paused`) is resumed.
  - A VM a cut wake left on a sleeping imp is killed if `GET /` says it never loaded, and
    `meta.json.loading` goes back to `meta.json`: the snapshot stays. `GET /` gets 10 s to answer,
    since Firecracker answers nothing during a large load. A VM that loaded gets the rest of the
    wake: the RAM reservation, the agent's ping and version check, and the guest clock. If any of it
    fails, the VM is killed and the snapshot dropped, since the guest may have written the disk; the
    imp boots cold.
  - A sleeping imp with `meta.json.loading` and no VM left drops its snapshot and boots cold next.
  - Half-written files go: a sleep's `.new` snapshot files, `meta.json.new`, `vm.json.new` and the
    watchdog slot's.

## Idle detection

Every 2 s, an imp counts as active when it has any of these:

- an open exec session (an attached session included), proxied connection, SSH connection or
  `imp proxy` tunnel, counted on the host; a detached session counts only through its CPU and TCP;
- established guest TCP connections, from the agent's `activity` (loopback does not count);
- Firecracker CPU above `IMP_IDLE_CPU_PERCENT` of one core (default 10; an idle guest uses about
  0.4);
- a live lease or hold: `imp hold <name> <duration>` or `leases.acquire` keeps an imp awake and
  wakes it ([leases](../guides/leases.md)).

A headless agent that waits on an LLM API keeps a TCP connection open, so it stays awake. An imp
with none of these for `IMP_IDLE_TIMEOUT_S` (default 60 s) goes to sleep.

## The watchdog

The idle loop asks every running imp's agent for its `activity` every 2 s. The watchdog counts the
answers: an agent silent for `IMP_WATCHDOG_TIMEOUT_S` (default 60), that also misses a 5 s ping, is
reported once in the log, and `imp ls` and the dashboard show it (`agentSilentSince`). An answer
clears it; so does a lifecycle operation holding the imp, which starts its count over.

Then `IMP_WATCHDOG_ACTION` decides:

| Action             | What impd does                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report` (default) | Nothing more. The proxy reaches the guest's TCP without the agent, so a deaf agent can still serve.                                                                                             |
| `restart`          | Kills Firecracker without asking the agent and boots the disk cold. The imp's `coldBootReason` says the watchdog did it.                                                                        |
| `snapshot`         | First writes the VM's memory to `<imp>/watchdog/` (mode 0700, files 0600), for a post-mortem, then boots cold. One slot per imp, replaced each time; without disk room it restarts without one. |

The slot counts in the disk check, a destroy removes it with the imp's directory, and backups copy
only disks. The log names its path. Recoveries take the imp's lock with a try-lock, as background
sleeps do, and back off: the first may run at once, each later one in the hour waits twice as long
(1 min, then 2), and after three in an hour the watchdog only reports.

## The RAM governor

impd keeps the RAM of awake imps under `IMP_RAM_BUDGET_MIB` (default 16384).

- **Measure.** Usage is the sum of Firecracker `Pss_Anon` + `Pss_Shmem` from `smaps_rollup`. Pages a
  woken guest only read are clean pages of the mem file, which the host can drop
  ([section 5](#5-ram-what-the-governor-measures)). `imp info` also reports the committed memory of
  awake imps.
- **Reserve.** Before a boot or a wake, impd reserves RAM under one global lock: a cold boot
  reserves `IMP_BOOT_RESERVE_PERCENT` (default 50) of the imp's memory, a wake the larger of what it
  owned at sleep and `IMP_WAKE_RESERVE_MIB` (default 256). A reservation counts until the
  measurement passes it, for at most 20 s.
- **Make room.** If the sum would pass the budget, impd sleeps the least recently active imps that
  are not held and not busy, until it fits. It sleeps one at a time, and measures and picks again
  after each. An imp whose lock is taken by the time its turn comes is skipped, not waited for
  ([background sleeps](#background-sleeps)); it and an imp whose sleep fails are not picked again.
  If it still cannot fit, or the imp's memory alone is larger than the budget, the request fails
  with `RAM_BUDGET_EXCEEDED`, which names the awake imps it could not sleep
  ([capacity refusals](../guides/leases.md#capacity-refusals)). impd does not start sleeping imps
  when together they cannot make room, and it gives up when the new pick after a skip or failure is
  short. A request that fails there loses only the sleeps done before that skip or failure; each of
  those imps wakes on its next request.
- **Enforce.** Every 5 s, impd sleeps LRU imps while measured usage is over the budget. When the
  imps it may sleep cannot bring usage under the budget, it sleeps all of them to get as close as it
  can. It logs each pass that sleeps an imp, and once when none is left.

Enforcement trades availability for the host. A governor sleep ignores the idle timeout, so it can
sleep an imp that served a request a moment ago, even when that does not reach the budget. The
budget protects the host, which the imps share with everything else on it, so impd takes back what
it can. While usage stays over, every boot and wake fails with `RAM_BUDGET_EXCEEDED`, so an imp it
slept does not wake only to go to sleep again.

## Findings

The design above comes from a prototype for sleep, wake and the governor, measured 2026-10-02. The
numbers are from a nested-virtualization dev box; treat them as the order of magnitude. The
measurements of the finished system are in [STATUS.md](../../STATUS.md#measured).

**Test host.** WSL2 (host kernel 6.6.87.2-microsoft-standard-WSL2), nested KVM on an AMD CPU, 16
threads. `/var/lib/imp` is a loop-mounted XFS file on the WSL ext4 disk. Firecracker v1.17.0,
snapshot format v12.0.0. Guests: 2 vCPUs, the ubuntu:24.04 rootfs, the CI kernel
(`.cache/vmlinux-ci`) and the custom kernel (`kernel/out/vmlinux`). Both kernels give the same
results. Bare metal timings will differ; treat these as the order of magnitude.

### 1. Result

Sleep and wake work. A process that holds a random value only in its memory keeps the value, its
pid, its start time and the boot id across three sleep/wake cycles. A cold boot of the same disk
afterwards does not have the value (negative control). Wake to first agent `ping` takes 50-150 ms.
The restored VM starts with about 20 MiB RSS and faults guest memory in from the memory file on
demand.

### 2. Measurements

| Measurement                                           | 1 GiB guest, idle |                 2 GiB guest, 300 MiB in tmpfs |
| ----------------------------------------------------- | ----------------: | --------------------------------------------: |
| Firecracker RSS before the first sleep                |            69 MiB |                                       390 MiB |
| `PATCH /vm Paused`                                    |            5-7 ms |                                          5 ms |
| `PUT /snapshot/create` Full, `sync_snapshot_files` on |         1.1-1.8 s |                                     3.3-3.7 s |
| `PUT /snapshot/create`, `sync_snapshot_files` off     |         0.5-1.4 s |                                     3.7-6.0 s |
| vmstate file                                          |         21-26 KiB |                                     21-26 KiB |
| mem file, apparent / on disk                          |     1.0 G / 1.0 G |                                 2.0 G / 2.0 G |
| mem file on disk after `fallocate --dig-holes`        |    63 MiB (99 ms) |                              381 MiB (217 ms) |
| `PUT /snapshot/load` (resume_vm), warm page cache     |          36-51 ms |                                      45-53 ms |
| load to first `ping`                                  |          15-43 ms |                                      36-43 ms |
| **Total wake (new FC process to ping)**               |      **51-94 ms** |                                  **81-96 ms** |
| Total wake, mem file dropped from page cache          |             75 ms |                                         58 ms |
| Firecracker RSS right after wake                      |         17-37 MiB |                                        20 MiB |
| Read the 300 MiB blob (md5) awake / right after wake  |                 - |                          310 ms / 578-1174 ms |
| Firecracker RSS after the blob is read                |                 - | 341 MiB (326 MiB `RssFile`, 15 MiB `RssAnon`) |

Notes:

- `sync_snapshot_files: false` was not reliably faster here. The loop-mounted XFS and WSL disk make
  write timings noisy. Measure again on the real host before you change the default.
- The "dropped from page cache" row used `dd oflag=nocache count=0` on the mem file. Through the
  loop device the WSL host still caches the file, so this row is not a true cold read.
- Firecracker writes every guest page into the mem file, so the file is dense even when the guest
  never touched most of its memory. Zero pages compress to holes with `fallocate --dig-holes`; the
  restore after that is correct (the in-memory proof passed after it).

#### Guest clock

| Measurement                                   | Result                                 |
| --------------------------------------------- | -------------------------------------- |
| Guest wall clock behind the host after wake   | 21.6-22.1 s after a 20 s sleep         |
| After `resumed {unix_ms}`                     | 2-4 ms                                 |
| `clock_realtime: true` on `/snapshot/load`    | no effect (guest clocksource is `tsc`) |
| `/proc/uptime` and `uptime_ms` across a sleep | do not include the time asleep         |

`clock_realtime` advances kvm-clock. Both guest kernels start on kvm-clock and then switch to `tsc`
("Switched to clocksource tsc"), so it does not move the guest clock. The `resumed` op is the
mechanism to use. It sets only `CLOCK_REALTIME`, so guest timers on `CLOCK_MONOTONIC` do not all
fire at once after a long sleep.

### 3. Firecracker API calls

#### Sleep calls

```sh
# 1. Pause the vCPUs.
PATCH /vm                {"state":"Paused"}
# 2. Write a full snapshot to NEW files (see gotcha 3).
PUT   /snapshot/create   {"snapshot_type":"Full",
                          "snapshot_path":"<imp>/snapshot/vmstate.new",
                          "mem_file_path":"<imp>/snapshot/mem.new",
                          "sync_snapshot_files":true}
# 3. Kill Firecracker (SIGKILL is fine: the VM is paused and the snapshot is on disk).
# 4. rename vmstate.new -> vmstate, mem.new -> mem. Optionally: fallocate --dig-holes mem.
```

#### Wake calls

```sh
# 1. Check: tap <imp-tap> exists, run/vsock.sock does NOT exist, the disk files are at the same
#    paths, the Firecracker binary and host kernel match the snapshot (gotcha 6).
# 2. Start a new firecracker --api-sock <imp>/run/api.sock. /snapshot/load must be the FIRST
#    call: no boot-source, machine-config, drives, vsock or network before it.
PUT /snapshot/load  {"snapshot_path":"<imp>/snapshot/vmstate",
                     "mem_backend":{"backend_type":"File","backend_path":"<imp>/snapshot/mem"},
                     "resume_vm":true}
# 3. ping the agent (retry for up to ~10 s), then:
{"op":"resumed","unix_ms":<host Date.now()>}
```

Optional load fields that work in 1.17 (tested):

```json
"network_overrides": [{"iface_id":"eth0","host_dev_name":"imp11"}],
"vsock_override":    {"uds_path":"<new path>/vsock.sock"}
```

With both overrides, the VM woke on a different tap and vsock path, the proof held, and TCP egress
through the new tap worked. The guest keeps its IP, so the new tap needs the same host-side /30.

### 4. Gotchas

1. **Stale vsock socket kills the load.** If `run/vsock.sock` exists, the load fails with
   `VsockUnixBackend: Error binding to the host-side Unix socket: Address in use (os error 98)` and
   the Firecracker process exits. Delete the file before every load.
2. **A failed load ends the Firecracker process.** The daemon must treat "load returned 4xx" or "FC
   exited" as a failed wake and fall back to a cold boot (and keep the snapshot for debugging, or
   delete it).
3. **The restored VM maps the mem file.** With the File backend the guest memory is a `MAP_PRIVATE`
   mapping of the mem file. Never write into that file while the VM runs, and write the next
   snapshot to a new file, then rename it. Disk space for the old mem file comes back only when the
   Firecracker process that maps it exits. Delete the snapshot files after the next sleep or a stop,
   not right after a wake.
4. **Disk and memory belong together.** The snapshot holds the guest page cache for the disk. Do not
   change the disk (restore a checkpoint, fsck, mount it) while the imp sleeps. A checkpoint of a
   sleeping imp must copy the mem and vmstate files with the disk, or the daemon must wake the imp
   and use `freeze` first. impd wakes it first.
5. **Exec connections do not survive.** On resume the guest closes every vsock connection. Agent
   behavior: the process group of a foreground exec gets SIGHUP; a process that ignores SIGHUP keeps
   running and stops counting as a session after 1 s. A named session survives: its client is only
   detached. Other background work must use `setsid`/`nohup`. TCP connections in the guest also
   reset ([what survives](#what-survives-a-sleep)).
6. **Version checks.** `firecracker --snapshot-version` prints the format this binary writes
   (`v12.0.0`); `firecracker --describe-snapshot <vmstate>` prints the format of a file. The
   snapshot is also tied to the host kernel and CPU (Firecracker docs: "Snapshots must be resumed on
   a software and hardware configuration which is identical"). Store the Firecracker version, the
   snapshot format and `uname -r` with the snapshot. On any mismatch, boot cold.
7. **The tap stays.** (Untested: a load with the tap missing. Expect a failed load, as with the
   vsock socket.) The load reconnects to the tap by name. Do not delete the tap at sleep.
8. **Snapshot create puts the whole mem file into the host page cache** (1-2 GiB of writes per
   sleep). Many imps that sleep at once cause a write burst. Serialize sleeps, or limit them to 2-3
   at a time.

### 5. RAM: what the governor measures

After a wake, guest pages that were only read are clean, file-backed pages of the mem file
(`RssFile`, `Private_Clean`). The host can drop them and read them again from the file. Pages the
guest writes become anonymous (`RssAnon`, `Private_Dirty`). Example: after the guest read its 300
MiB blob, Firecracker had 341 MiB RSS, of which 326 MiB was clean `RssFile`.

So the governor counts `Pss_Anon` + `Pss_Shmem` from `/proc/<pid>/smaps_rollup`, not the full PSS. A
woken imp with mostly clean pages costs less than its PSS. A cold-booted imp has only anonymous
pages.

### 6. RAM reclamation for awake VMs: the balloon

Kernel config needed in the guest: `CONFIG_VIRTIO_BALLOON=y` and `CONFIG_PAGE_REPORTING=y`. Both
kernels have them. The guest reports `page_reporting_order=9` (2 MiB blocks).

The balloon device must be configured before `InstanceStart`. It cannot be added to a running or
restored VM, and the stats interval cannot be turned on later. A snapshot keeps the balloon
configuration.

Test: 2 GiB guest. Write 900 MiB to tmpfs, delete it, sample Firecracker RSS. Then a perl process
allocates a 700 MiB string and exits.

| Balloon config                     | After 900 MiB tmpfs freed (RSS, MiB)                    | 15 s after the perl process exits |
| ---------------------------------- | ------------------------------------------------------- | --------------------------------- |
| none (control)                     | 987 → 987 (no change)                                   | 1492                              |
| `free_page_reporting: true`        | 988 → 738 (+1 s) → 482 (+3 s) → 227 (+6 s) → 91 (+15 s) | 94 (990 at +6 s)                  |
| `free_page_hinting: true`, no run  | 986 → 986                                               | 1492                              |
| `free_page_hinting`, after one run | -                                                       | 1492 → 94 in < 200 ms             |

- **Free page reporting works** and needs no host action. The guest returns about 250 MiB per 2 s.
  Use it on every VM.
- **Free page hinting** also works, but only when the host starts a run:
  `PATCH /balloon/hinting/start {"acknowledge_on_stop":true}` (the method is PATCH; the Firecracker
  ballooning doc shows POST, which returns `Invalid HTTP Method`). It is a developer preview with a
  known memory-corruption race (Firecracker docs). Do not use it.
- **Stats work**: `GET /balloon/statistics` gives `free_memory`, `available_memory`, `total_memory`,
  `disk_caches`, faults and swap. Polling interval 1 s. Stats keep working after a restore.
- **Inflate works**: `PATCH /balloon {"amount_mib":1024}` reached `actual_mib: 1024` in under 3 s.
  The governor can use it to squeeze a VM, with `deflate_on_oom: true` as the safety valve.
- **Reporting makes snapshots small.** After reporting, the mem file still has 2.0 G on disk, but
  `fallocate --dig-holes` takes it to 79 MiB in 244 ms.

Balloon config for every VM, before `InstanceStart`:

```json
PUT /balloon {"amount_mib":0,"deflate_on_oom":true,"stats_polling_interval_s":1,"free_page_reporting":true}
```

### 7. Resume detection inside the guest

The guest can see a resume without the host: the VMGenID device changes and the kernel logs
`random: crng reseeded due to virtual machine fork`. The CI kernel also has `/dev/vmclock0`
(`CONFIG_PTP_1588_CLOCK_VMCLOCK`), which can be polled. The custom kernel does not have VMCLOCK. The
agent does not use either: the host already knows when it woke the VM, and the agent cannot learn
the correct time without the host. The clocks do not jump at resume, so a monotonic-against-realtime
check sees nothing.

### Young guests

A host kernel before Linux 6.7 wakes a guest slowly when its snapshot was taken less than about a
second after the VM started. The wake then takes 0.75–1.1 s, not about 0.1 s. Measured on WSL2 (host
kernel 6.6.87), 1 GiB guest, 2 vCPUs, with the sleep right after `imp start`:

| Sleep after the cold boot                    | Wakes                      |
| -------------------------------------------- | -------------------------- |
| at once (guest uptime about 0.45 s)          | 6 of 6: 750–1076 ms        |
| 0.3 s or more later                          | 10 of 10: 61–135 ms (impd) |
| at once after a wake or an exec, older guest | 8 of 8: 75–92 ms           |

**Cause.** At a restore, Firecracker sets each vCPU's TSC to its saved value. KVM's legacy TSC code
treats a TSC written within one second's worth of cycles of the vCPU's start as an attempt to keep
vCPUs in sync, and keeps the start-time offset instead. So the restored TSC starts again near 0. The
guest clocksource is `tsc`, and the guest clock does not go backwards: it stands still until the TSC
passes the saved value. In that time the guest's timers do not expire, the deadline timer fires
about 10,000 times per vCPU, and the agent does not answer. The wake takes as long as the guest's
age at the snapshot.

The evidence from one slow wake:

- A guest `rdtsc` read 0.828 s before the sleep and 1.028 s 1.1 s after the wake. With the snapshot
  at 2.7 s, the TSC went on from its value.
- Guest `CLOCK_MONOTONIC` moved 0.2 s in 1.1 s of wall time. A `sleep 0.05` in the guest returned
  after 0.8 s.
- `LOC` in `/proc/interrupts` went from about 200 to 8,000–12,000 per vCPU, against about 100 in a
  fast wake.
- On the host, one vCPU thread ran without a break for 560–780 ms, in the guest, with no page faults
  and under 2 ms of run delay. Page faults on the mem file and host CPU contention are ruled out.

Linux 6.7 fixed this upstream ([bf328e22e472](https://git.kernel.org/torvalds/c/bf328e22e472), "KVM:
x86: Don't sync user-written TSC against startup values"): the one-second rule now applies only
after userspace has written a TSC once. 6.6.87 does not have it.

**What impd does.** Before the pause, impd asks the agent for the guest's uptime (`ping`
`uptime_ms`, `CLOCK_BOOTTIME`). Like the TSC, it leaves out time asleep. Below
`IMP_SLEEP_MIN_GUEST_UPTIME_MS` (default 1500; the TSC also counts about 0.2 s before the kernel
starts, so the margin is about 0.7 s) impd waits for the rest. That costs up to about 1.2 s, only
for a sleep within 1.5 s of a cold boot, and on the sleep, not the wake. A woken guest is always
older than that, so the wait never repeats.

Only `imp sleep` and impd's stop wait in practice. The governor sleeps a young guest at once, and
its next wake is slow ([background sleeps](#background-sleeps)); an idle sleep never meets a young
guest. On a host kernel with the fix, `0` turns the wait off; impd does not read the kernel version,
since backports make it unreliable. An agent that does not answer within 250 ms, or cannot read its
clock, does not hold the sleep.

`scripts/bench-wake.sh` measures it on any host: a cold boot, a sleep at once and a wake, 3 cycles,
and a limit on the median wake. With the wait off on WSL2: median 793 ms. With the default: median
142 ms, and each sleep waited about 1.05 s.

The prototype saw slow wakes after back-to-back wake and sleep cycles and took them for work that
built up across resumes. It was this effect: each cycle kept the guest young, and its uptime is what
counts, not how soon the sleep follows a wake.
