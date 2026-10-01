# Sleep and wake: prototype findings

Prototype for DESIGN.md 2.8 (sleep/wake) and 2.9 (RAM governor). Script: `scripts/proto-sleep.sh`
(phases `sleep`, `big`, `balloon`). Measured 2026-10-02.

**Test host.** WSL2 (host kernel 6.6.87.2-microsoft-standard-WSL2), nested KVM on an AMD CPU, 16
threads. `/var/lib/imp` is a loop-mounted XFS file on the WSL ext4 disk. Firecracker v1.17.0,
snapshot format v12.0.0. Guests: 2 vCPUs, the ubuntu:24.04 rootfs, the CI kernel
(`.cache/vmlinux-ci`) and the custom kernel (`kernel/out/vmlinux`). Both kernels give the same
results. Bare metal timings will differ; treat these as the order of magnitude.

## 1. Result

Sleep and wake work. A process that holds a random value only in its memory keeps the value, its
pid, its start time and the boot id across three sleep/wake cycles. A cold boot of the same disk
afterwards does not have the value (negative control). Wake to first agent `ping` takes 50-150 ms.
The restored VM starts with about 20 MiB RSS and faults guest memory in from the memory file on
demand.

## 2. Measurements

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

### Guest clock

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

## 3. Procedure and exact API calls

### Sleep

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

### Wake

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

## 4. Gotchas

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
   and use `freeze` first.
5. **Exec sessions do not survive.** On resume the guest closes every vsock connection. Agent
   behavior: the process group of a foreground exec gets SIGHUP; a process that ignores SIGHUP keeps
   running and stops counting as a session after 1 s. Background work must use `setsid`/`nohup`. TCP
   connections in the guest also reset (DESIGN.md 2.8).
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

## 5. RAM: what the governor should measure

After a wake, guest pages that were only read are clean, file-backed pages of the mem file
(`RssFile`, `Private_Clean`). The host can drop them and read them again from the file. Pages the
guest writes become anonymous (`RssAnon`, `Private_Dirty`). Example: after the guest read its 300
MiB blob, Firecracker had 341 MiB RSS, of which 326 MiB was clean `RssFile`.

Recommendation: the governor counts Firecracker PSS (as DESIGN.md 2.9 says), but reads
`/proc/<pid>/smaps_rollup` and also records `Private_Dirty` and `Pss_Anon`. Under pressure, a woken
imp with mostly clean pages costs less than its PSS. A cold-booted imp has only anonymous pages.

## 6. RAM reclamation for awake VMs: the balloon

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

## 7. Resume detection inside the guest

The guest can see a resume without the host: the VMGenID device changes and the kernel logs
`random: crng reseeded due to virtual machine fork`. The CI kernel also has `/dev/vmclock0`
(`CONFIG_PTP_1588_CLOCK_VMCLOCK`), which can be polled. The custom kernel does not have VMCLOCK. The
agent does not use either: the host already knows when it woke the VM, and the agent cannot learn
the correct time without the host. The clocks do not jump at resume, so a monotonic-against-realtime
check sees nothing.

## 8. Recommendations for packages/daemon

`sleep(imp)`, in order:

1. Refuse if a sleep or wake is already running for this imp (a per-imp lock).
2. `PATCH /vm {"state":"Paused"}`.
3. `PUT /snapshot/create` to `vmstate.new` and `mem.new` (Full, `sync_snapshot_files: true`). On
   failure: `PATCH /vm {"state":"Resumed"}`, delete the `.new` files, report the error.
4. SIGKILL Firecracker and wait for the pid to exit.
5. Rename the `.new` files over `vmstate` and `mem`. Then `fallocate --dig-holes mem` (optional,
   about 100-250 ms per GiB).
6. Store in the DB: state `sleeping`, Firecracker version, snapshot format, `uname -r`, mem size.
7. Delete `run/api.sock` and `run/vsock.sock`. Keep the tap.

`wake(imp)`, in order:

1. Reserve RAM in the governor. Expect a small start (about 20-40 MiB RSS) that grows to the working
   set.
2. Compare the stored versions with the current ones. On a mismatch: delete the snapshot and boot
   cold.
3. Check that the tap exists; create it if not (same name and /30). Delete `run/vsock.sock` and
   `run/api.sock`.
4. Start Firecracker detached (`setsid`). Wait for `api.sock`.
5. `PUT /snapshot/load` with the File backend and `resume_vm: true` as the first call. If it fails
   or Firecracker exits: boot cold.
6. `ping` with retry, 10 s budget.
7. Send `resumed` with `Date.now()`.
8. Set the state to `running`. Keep the snapshot files until the next sleep or a stop (gotcha 3).

Cold boot (all VMs): add the balloon config in section 6 before `InstanceStart`.

## Open: slow wakes after back-to-back cycles

A wake normally takes about 80 ms. When an imp is slept again within about a second of a wake or an
exec, the next wake takes 650–850 ms, and the delay grows with each back-to-back cycle. A snapshot
taken at least 3 s after a wake restores fast again.

What was measured during a slow wake:

- The agent accepts the vsock `CONNECT` at once but answers about 700 ms later.
- Both vCPU threads are busy, mostly in kernel time, with only about 300 minor faults. Lazy page
  loading is not the cause.
- Disabling free page reporting does not help. Skipping the `resumed` clock set does not help.

Working theory: the guest does about 0.7 s of kernel work after each resume (for example clock and
timer catch-up, or deferred work queued while paused). A snapshot taken while that work is still
running captures it, so the next resume repeats it and adds more. A minimum awake time of 3 s before
an idle sleep avoids the problem in normal use; the idle timeout is far longer.
