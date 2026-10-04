# CPU limits and resource use

Each imp can have a CPU limit and a CPU weight. impd also samples each running imp's CPU, memory and
network every 5 s and shows the result in `imp ls`, `imp top`, the dashboard and the
[telemetry](./events.md#telemetry).

## Limits and weights

```sh
imp new box --cpu-limit 1.5 --cpu-weight 200
imp set box --cpu-limit 0.5        # applies at once when box runs
imp set box --cpu-limit none       # no limit
imp set box --cpus 4               # vCPUs: only while box is stopped
imp set box --http-port 3000       # the port box's URL reaches, from the next request
```

| Setting        | Default             | Range                       | Meaning                                                            |
| -------------- | ------------------- | --------------------------- | ------------------------------------------------------------------ |
| `--cpu-limit`  | `none`              | 0.1 to the host's CPU count | The most CPU time the VM gets, in cores: `1.5` is one and a half.  |
| `--cpu-weight` | `100`               | 1 to 10000                  | The VM's share of the CPU when imps compete; idle time is free.    |
| `--cpus`       | `IMP_DEFAULT_VCPUS` | 1 to 32                     | The vCPUs the guest sees. A limit under the vCPU count slows each. |

A fork copies the source's limit and weight. A change to a sleeping imp applies at its next wake. A
sleep or a wake lifts the limit while Firecracker writes or loads the memory snapshot, so a low
limit never slows those steps. Memory has its own flags: `--memory` and `--max-memory`
([elastic memory](../architecture/memory.md)).

## The memory limit

Each VM's cgroup also caps its memory a little over the guest's: 256 MiB more than `--memory`, or an
eighth more above 2 GiB, with no swap. A guest never reaches it on its own; a VM that leaks host
memory does. The kernel then kills the whole VM, and `imp ls --json` shows the stopped imp with the
error `its memory limit killed firecracker`. See [cgroups](../architecture/daemon.md#cgroups).

**NOTE:** impd enforces limits only when the host container runs in a private cgroup v2 namespace
(`--cgroupns=private`, which `scripts/dev.sh`, `deploy/imp-host.service` and `deploy/compose.yaml`
pass) and `setup-cgroups.sh` can remount its cgroupfs read-write. Without either, impd logs
`CPU limits are kept, not applied`, stores the settings, `imp info` shows `limits OFF`, and
`imp info --json` shows `cpu.limitsEnforced: false`. Jailed VMs cannot start then.

## Resource use

`imp ls` has a `CPU` column: the last sample's use in percent of one core, over the limit when there
is one (`45% / 1.5`). `imp top` refreshes a table of every imp, busiest first, as impd's events
arrive and every 2 s; `imp top --once` prints it once, `--json` prints the imps with their
`resources`.

| Column      | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `CPU`       | Use over the last 5 s sample, in percent of one core, over the limit.          |
| `WEIGHT`    | The CPU weight.                                                                |
| `THROTTLED` | Time the limit held the VM back since the last boot, wake or adopt.            |
| `RAM`       | Memory the VM owns, as the RAM governor counts it.                             |
| `DISK`      | What a destroy frees over the disk size, from impd's disk-usage pass.          |
| `NET IN`    | Bytes the guest received since the last boot, wake or adopt.                   |
| `NET OUT`   | Bytes the guest sent since the last boot, wake or adopt.                       |
| `WAKES`     | Wakes since the imp was created, a cold boot that stood in for a wake too.     |
| `AWAKE`     | Total time the imp ran. A crash ends the span when impd last saw the VM alive. |

`THROTTLED`, `NET IN` and `NET OUT` count from `since` in `imp ls --json`: the end of the last boot
or wake, or the moment impd adopted a running VM after a restart. impd takes a baseline then,
because the tap outlives its VM and its counters still hold earlier boots' traffic. `WAKES` and
`AWAKE` live in the database and survive restarts.

The dashboard shows the CPU in the imp list, and on the imp's page a CPU panel with the sample, the
wakes, the time awake, and a form for the limit and the weight.
