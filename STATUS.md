# imp — status

Updated at each milestone. Newest state at the top of each section.

## Milestones

| #   | Milestone                                                                       | State       |
| --- | ------------------------------------------------------------------------------- | ----------- |
| M0  | Firecracker boots under nested KVM inside a privileged container                | done        |
| M1  | Walking skeleton: agent as PID 1 from a read-only system drive, exec over vsock | done        |
| M2  | Workspace, API contract, db, addressing                                         | done        |
| M3  | impd lifecycle: create, list, exec, console, destroy (CLI end to end)           | in progress |
| M4  | Images: OCI → ext4, images/base with Docker, images/dev, bring your own         | in progress |
| M5  | Checkpoint, restore, fork (XFS reflink)                                         | todo        |
| M6  | Sleep and wake (memory snapshot), idle detection, wake proxy                    | done        |
| M7  | RAM governor (budget, LRU sleep), scale test                                    | done        |
| M8  | Restart survival (re-adopt VMs, sleep on SIGTERM)                               | done        |
| M9  | Tailscale                                                                       | todo        |
| M10 | `scripts/acceptance.sh` passes twice from a clean state                         | todo        |

## Measured

| What                                 | Value      | Notes                                                                                 |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------- |
| Stock VM boot to init                | ~930 ms    | CI kernel 6.1.155, nested KVM on WSL2, 50 ms poll granularity                         |
| XFS reflink of a 500 MB file         | 321 ms     | includes `cp` process start in an Alpine container                                    |
| InstanceStart → agent ping           | 412–464 ms | agent as PID 1 from squashfs, switch_root to ext4; kernel ~275 ms, init→listen ~60 ms |
| Reflink clone of a 32G sparse rootfs | 3 ms       | in the host container                                                                 |
| Sleep, 512 MiB guest                 | 0.5-2.1 s  | snapshot 0.4-2.1 s, dig holes 50-80 ms; mem file 50-60 MiB on disk                    |
| Wake, impd log (FC start to resumed) | 59-101 ms  | load 30-55 ms, agent 21-40 ms; up to 1 s when the snapshot came right after a wake    |
| HTTP request that wakes an imp       | 89-116 ms  | through the proxy, request to response; `x-imp-wake-ms` 72-97                         |
| Idle 512 MiB ubuntu guest RAM        | 58-66 MiB  | anonymous (governor count) after boot; 3-6 MiB right after a wake                     |
| Idle Firecracker CPU                 | 0.4%       | of one core                                                                           |
| Sleep every imp on SIGTERM           | 1.7-2.5 s  | 5 imps, 410 MiB each, 2 at a time                                                     |

## Blockers

None.

## Notes

- The dev box is WSL2 with nested virtualization. Expect bare metal to be faster.
- WSL 6.6 kernel: `mkfs.xfs` needs `-i nrext64=0,exchange=0 -n parent=0`.
- Guests use a custom 6.1.188 kernel (`kernel/build.sh`): the CI kernel lacks nftables and the
  iptables raw table that Docker 28+ needs. First build 8m35s; rebuilds about 32s.
