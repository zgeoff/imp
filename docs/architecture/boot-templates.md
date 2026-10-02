# Boot templates

A cold boot spends most of its time in the guest kernel's boot before the agent answers. A boot
template skips it: impd boots one guest per shape, parks its agent before it touches a user disk,
and snapshots it. Each later cold boot of that shape restores the snapshot and gives the guest its
own values with `claim`. `IMP_BOOT_TEMPLATES=false` turns this off.

The code is in `packages/daemon/src/templates/boot-templates.ts` (the store),
`packages/daemon/src/vmm/template-vm.ts` (the Firecracker calls) and `agent/internal/boot/claim.go`
(the guest side).

## Key

A template is reused only where a restore inherits exactly what a cold boot would have. Its key is
the sha256 of:

- the guest kernel's sha and the system drive's sha (the drive's sha covers the agent)
- the Firecracker version, the snapshot format version and the host kernel (`uname -r`)
- the template's kernel command line
- the devices: the two drives, the vsock CID, `eth0` and the balloon
- the vCPUs and the memory size

The image is not in the key: the template never opens a user disk. Templates live in
`<data>/templates/<key>/` with `vmstate`, `mem` and `meta.json`. At startup impd removes every
template whose key the host no longer makes, and what a build cut short left, before the system
drive GC runs. The GC keeps each drive a template names.

## Make

A cold boot of a shape with no template boots the kernel as before. The second such miss of a key
starts the template's build in the background, so no create waits for it ([limits](#limits)). Misses
of one key share one build; builds run one at a time, since they share one tap (`imp-tpl`).

1. The build asks the disk budget for room for the whole memory, and the RAM governor for free room:
   it never sleeps an imp to make room for a template.
2. impd boots a VM with `imp.template=1` on the kernel command line and nothing else that names an
   imp. Its rootfs is `<data>/templates/placeholder.ext4`, a 1 MiB file: the snapshot records the
   drive's path, so every template names the same one.
3. The agent mounts its own `/proc`, `/sys`, `/dev`, cgroup2, `/run` and `/dev/pts`, makes the inner
   container's cgroup, reads the command line, and parks: it serves `ping` (with
   `stage: "template"`) and `claim` on the vsock port, and refuses every other op. It opens no inet
   socket, so the kernel has made no TCP secrets yet.
4. impd waits until the guest is `IMP_SLEEP_MIN_GUEST_UPTIME_MS` old
   ([young guests](./sleep-and-wake.md#young-guests)), pauses it and writes a full snapshot into a
   new directory. It kills the VM, digs holes in the mem file, writes `meta.json` and renames the
   directory into place.

A rebuild always writes a new directory and renames it. impd never truncates or punches holes in a
mem file that a VM has mapped: a restored VM maps it `MAP_PRIVATE`
([gotcha 3](./sleep-and-wake.md#4-gotchas)). A removed template is renamed away first, and its mem
file lives on until its last VM exits.

## Restore

When the shape has a template, a cold boot:

1. Starts Firecracker in the imp's cgroup.
2. Loads the snapshot with `resume_vm: false`, `network_overrides` (the imp's tap) and
   `vsock_override` (the imp's socket).
3. Resumes the VM and waits for the parked ping. Meanwhile the host prepares the imp's disk: a new
   imp's is cloned and grown; a restore from a checkpoint or a backup copies or downloads it, and
   the parked guest waits for it.
4. Points `rootfs` at the imp's disk with `PATCH /drives/rootfs` and its absolute path, once the
   disk is ready. The config change is how virtio-blk tells the guest the disk's new size.
5. Sends `claim`, and waits for the booted agent's ping, as a cold boot does.

Everything after that is a cold boot's: impd writes the VM identity, so the next sleep, wake, fork
and checkpoint see a normal imp. If a step fails, impd kills the VM:

- A step that reads only the template (the load, the resume, the parked ping) is the template's
  fault. impd removes the template, boots the kernel, and the next misses build it again. Only the
  build that failed is removed: a template rebuilt since has another `buildId` in `meta.json`.
- A failure from the patch on (the claim, the rest of the boot) is the imp's own. impd boots the
  kernel, and the template stays.
- A disk that fails to clone, grow or download fails the create, as on a cold boot, and the template
  stays.

## Limits

A template costs RAM while it builds and disk for its mem file, up to the whole memory. So:

- **2 misses.** A key builds on its second miss, so a shape booted once costs nothing.
- **4 templates.** Past 4, the least recently restored goes. Odd `--memory` and `--cpus` values
  cannot fill the disk.
- **Free room only.** A build holds room on the disk for the whole memory until its rename, and
  takes free RAM: it never sleeps an imp. A host without the room turns the build away; the next
  build of the key waits 60 s, and the refusal counts as no failure, since a host near its budget is
  the normal case.
- **Failed builds back off.** The next build of a key that failed waits 60 s, then 120 s. The third
  failure turns the key off until impd restarts.
- **Failed restores.** 3 restores of a key in a row that fail in the template turn it off until impd
  restarts. A good restore resets the count. A failure of the imp's own counts not at all, nor does
  one of a template that was evicted or rebuilt after the restore found it.

## Claim

`claim` carries the imp's id, hostname, address, gateway, IPv6 address and gateway (when the host
gives imps IPv6), DNS servers and MAC, the host's clock, a 64-byte seed and the identity reset flag.
The parked agent then:

1. Sets the clock, so nothing after stamps the template's time.
2. Credits the seed to the entropy pool (`RNDADDENTROPY`) and reseeds the CRNG at once
   (`RNDRESEEDCRNG`). Firecracker's VMGenID also makes the kernel reseed after the restore
   (`random: crng reseeded due to virtual machine fork`); the seed does not rely on it. The agent
   logs `boot: claim: crng reseeded from a 64-byte seed` to the console.
3. Sets `eth0`'s MAC.
4. Waits, for up to 2 s, until `vda` reports the size in the claim's `disk_bytes`, rounded down to
   whole 512-byte sectors: the size change from the restore's `PATCH` reaches the guest as a config
   interrupt. A disk still at the wrong size after 2 s fails the claim, and impd boots the kernel.
   Then it drops `vda`'s buffers (`BLKFLSBUF`) and rereads its partition table.
5. Answers, closes the parked listener, and goes on as a cold boot: it mounts `vda` at `/user`,
   grows the filesystem and starts the [inner container](./agent.md#the-inner-container) on it.

The rest of the boot runs in the same process and takes the claim's values. It never reads the
kernel command line again, which on a restored guest is the template's. When the flag is set, it
runs the identity reset, inside the inner container, of an imp from a
[template image](../guides/templates.md#identity).

## RAM

Design decision: the governor counts `Pss_Anon` + `Pss_Shmem` for a restored VM, as for every VM
([section 5](./sleep-and-wake.md#5-ram-what-the-governor-measures)), and not `Pss_File`. The plan
proposed adding `Pss_File`; that would also count every woken imp's clean mem-file pages, which
section 5 leaves out on purpose. A restore needs nothing more:

- Firecracker maps the template's mem file `MAP_PRIVATE`. The pages a guest only reads are clean
  file pages, which the host can drop and read again, as with a woken imp's mem file.
- A page the guest writes becomes anonymous and counts in `Pss_Anon`.
- PSS splits a shared page among the processes that map it. If `Pss_File` were counted, the sum over
  every VM of a template would count each of its resident pages once.

Measured on WSL2 with the `e2e-ws` image at 288 MiB, right after `imp new`:

| VM                 | `Rss`  | `Pss_Anon` | `Pss_File` |
| ------------------ | ------ | ---------- | ---------- |
| a cold boot        | 59 MiB | 56 MiB     | 3 MiB      |
| a restore (3 of 3) | 37 MiB | 13 MiB     | 9 MiB      |

## Accepted risks

Every imp restored from one template shares what the kernel made before the snapshot:

- **`boot_id`** (`/proc/sys/kernel/random/boot_id`) is the template's.
- **The slab freelist seeds** (`CONFIG_SLAB_FREELIST_RANDOM`) are the template's. An attacker who
  learns them in one imp knows them for every imp of that template on the host.
- **KASLR** changes nothing: the guest logs `KASLR disabled` on every boot, since Firecracker loads
  the uncompressed `vmlinux` at its link address. Every imp, restored or not, has the same kernel
  layout.
- **The MAC.** A driver rebind of `eth0` in the guest brings back the template's MAC
  (`06:00:a9:fe:ff:fe`). The tap still carries the traffic; the guest's own address does not change.

What the kernel makes later is the imp's own: the TCP ISN and timestamp secrets, made on the first
inet socket after the claim, and everything read from the CRNG. The `boot-templates` e2e suite
checks that the TCP ISN secrets of restored imps differ, with `isn-probe` in the `e2e-ws` image.

## Numbers

`imp new` until the booted agent answers (then stage 2), through the API, 288 MiB and 1 vCPU, on
WSL2 (kernel 6.6). A dropped page cache is `echo 3 > /proc/sys/vm/drop_caches` before each create.

| Boot                     | Page cache | p50    | p95     |
| ------------------------ | ---------- | ------ | ------- |
| kernel                   | warm       | 783 ms | 855 ms  |
| template                 | warm       | 435 ms | 549 ms  |
| kernel                   | dropped    | 875 ms | 1056 ms |
| template                 | dropped    | 607 ms | 719 ms  |
| kernel, identity reset   | warm       | 985 ms | 1131 ms |
| template, identity reset | warm       | 508 ms | 811 ms  |
| kernel, identity reset   | dropped    | 932 ms | 1317 ms |
| template, identity reset | dropped    | 761 ms | 1081 ms |

The `boot-templates` e2e suite times 10 `imp new` runs through the CLI and writes the spans to
`metrics.jsonl` (`bootTemplateNewMs`, `bootTemplateNewSpansP50Ms`). The CLI's wall time on WSL2 was
601 ms p50 and 775 ms p95. The p50 of each span:

| Span               | p50    | What it is                                                      |
| ------------------ | ------ | --------------------------------------------------------------- |
| `cli`              | 230 ms | the CLI process and the API round trip: wall time less impd's   |
| `record`           | 12 ms  | the image lookup, the disk budget and the imp's row             |
| `clone`            | 46 ms  | the slot's firewall and the disk clone                          |
| `size`             | 64 ms  | the disk grown past the image, its filesystem grown on the host |
| `admit` + `setup`  | 7 ms   | the RAM governor, the tap and the cgroup                        |
| `spawn`            | 35 ms  | Firecracker started                                             |
| `load` to `resume` | 5 ms   | the snapshot load, `PATCH /drives/rootfs` and the resume        |
| `parked` + `claim` | 46 ms  | the parked guest's first ping, then `claim`                     |
| `stage2`           | 120 ms | stage 1 mounts and grows the disk, switches root; stage 2 up    |
| `finish`           | 22 ms  | the VM identity, the imp's state and the reply                  |

impd's own part (`created in`) was 371 ms. impd logs it per create with the step spans on the boot's
line.

Since then, the disk is cloned and grown while the template restores, and stage 2 runs in the stage
1 process with the system mounts made before the template parks. impd's part is now 276-300 ms p50.
`imp new` through the compiled CLI is about 350 ms end to end: the CLI's own start and round trip
add about 70 ms (about 100 ms for `scripts/imp`, which runs the CLI from source). The e2e `cli` span
also counts the test process that spawns the CLI, so it reads higher.

The grow of a new disk past the image's filesystem is a known cost: with `--disk 4g`, the image's
own size, impd's part was 272 ms before the overlap, against 345 ms with the default disk. A default
disk the image's size would need a grown copy of each image, or a smaller `IMP_DEFAULT_DISK_GIB`;
both stay as they are.
