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

To sleep an imp, impd takes the imp's lock and a slot of a host-wide semaphore (2 sleeps at a time,
[gotcha 8](#4-gotchas)), then:

1. Reads the RAM the VM owns now, for the next wake's reservation.
2. Pauses the VM (`PATCH /vm`).
3. Writes a full snapshot to `vmstate.new` and `mem.new` (`PUT /snapshot/create`). If that fails,
   impd deletes the `.new` files and resumes the VM; the imp stays awake.
4. Kills Firecracker with SIGKILL and waits for it to exit. The VM is paused and its snapshot is on
   disk, so nothing needs a clean shutdown.
5. Renames the `.new` files over `vmstate` and `mem`. It never writes into the old mem file: a woken
   VM maps it `MAP_PRIVATE` ([gotcha 3](#4-gotchas)).
6. Deletes `api.sock` and `vsock.sock`, and runs `fallocate --dig-holes` on the mem file. A 2 GiB
   file with 300 MiB in use becomes 381 MiB. A failure here only costs disk.
7. Writes `meta.json` and sets the state to `sleeping`. The tap stays.

If Firecracker is gone after a failed sleep, impd drops the snapshot and marks the imp `stopped`.

## Wake

1. impd reads `meta.json` and compares it with this host. On no snapshot or any difference, it boots
   the disk cold instead.
2. It reserves RAM: the larger of what the VM owned at sleep and `IMP_WAKE_RESERVE_MIB`.
3. It creates the tap if it is gone (a container restart removes taps).
4. It starts Firecracker, which first removes a stale `vsock.sock` ([gotcha 1](#4-gotchas)), and
   makes `PUT /snapshot/load` with `resume_vm: true` the first API call.
5. It pings the agent for up to 10 s, then sends `resumed` with the host time. Without it the guest
   clock is behind by the time asleep.
6. It sets the state to `running`. Pages then fault in lazily from the mem file.

If the load or the agent fails, impd kills the new Firecracker and boots the disk cold. The disk is
always the truth.

Snapshot files stay until the next sleep renames over them, a stop, a restore or a cold boot.

### Snapshot identity

`meta.json` records the Firecracker version, the snapshot format, the host kernel (`uname -r`), and
hashes of the guest kernel and the system drive. The snapshot holds the guest kernel in memory and
the guest's page cache of the system drive, so either change means a cold boot. It also records the
imp's memory size and the RAM the VM owned at sleep.

## What survives a sleep

- In-memory processes, tmpfs contents and everything else in RAM survive.
- TCP connections reset.
- On wake the guest closes every vsock connection. An exec whose host side hangs up gets SIGHUP and
  is detached after 1 s, so it does not keep the imp awake.

Anything that needs a VM wakes a sleeping imp and cold-boots a stopped one: `exec`, `console`, the
proxy, `start`, `wake` and `hold`. `stop` frees the memory; it does not keep the imp off.

## Restarts

- On SIGTERM or SIGINT, impd sleeps every awake imp, so a container restart keeps memory.
  `scripts/dev.sh down` gives it 120 s.
- On SIGHUP, impd exits without sleeping anything. Firecracker processes are detached (`setsid`), so
  the next impd re-adopts every live VM by pid and API socket, even one whose agent answers late.
- After a crash, an imp with no live VM is marked `stopped` and boots cold. Sleeping imps stay
  asleep and wake on demand.

## Idle detection

Every 2 s, an imp counts as active when it has any of these:

- an open exec session or proxied connection, counted on the host;
- established guest TCP connections, from the agent's `activity` (loopback does not count);
- Firecracker CPU above `IMP_IDLE_CPU_PERCENT` of one core (default 10; an idle guest uses about
  0.4);
- a hold: `imp hold <name> <duration>` keeps an imp awake and wakes it; `0` releases.

A headless agent that waits on an LLM API keeps a TCP connection open, so it stays awake. An imp
with none of these for `IMP_IDLE_TIMEOUT_S` (default 60 s) goes to sleep.

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
  are not held and not busy, until it fits. If it still cannot fit, or the imp's memory alone is
  larger than the budget, the request fails with `RAM_BUDGET_EXCEEDED`.
- **Enforce.** Every 5 s, impd sleeps LRU imps while measured usage is over the budget.

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
5. **Exec sessions do not survive.** On resume the guest closes every vsock connection. Agent
   behavior: the process group of a foreground exec gets SIGHUP; a process that ignores SIGHUP keeps
   running and stops counting as a session after 1 s. Background work must use `setsid`/`nohup`. TCP
   connections in the guest also reset ([what survives](#what-survives-a-sleep)).
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

### Open: slow wakes after back-to-back cycles

A wake right after another wake or exec takes 650–850 ms instead of about 80 ms. Normal idle
timeouts never hit it. [#33](https://github.com/zgeoff/imp/issues/33) tracks it.
