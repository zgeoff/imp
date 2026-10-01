# imp — status

Updated at each milestone. Newest state at the top of each section.

## Milestones

| #   | Milestone                                                                       | State       |
| --- | ------------------------------------------------------------------------------- | ----------- |
| M0  | Firecracker boots under nested KVM inside a privileged container                | done        |
| M1  | Walking skeleton: agent as PID 1 from a read-only system drive, exec over vsock | done        |
| M2  | Workspace, API contract, db, addressing                                         | done        |
| M3  | impd lifecycle: create, list, exec, console, destroy (CLI end to end)           | done        |
| M4  | Images: OCI → ext4, images/base with Docker, images/dev, bring your own         | done        |
| M5  | Checkpoint, restore, fork (XFS reflink)                                         | done        |
| M6  | Sleep and wake (memory snapshot), idle detection, wake proxy                    | in progress |
| M7  | RAM governor (budget, LRU sleep), scale test                                    | in progress |
| M8  | Restart survival (re-adopt VMs, sleep on SIGTERM)                               | in progress |
| M9  | Tailscale                                                                       | done        |
| M10 | `scripts/acceptance.sh` passes twice from a clean state                         | in progress |

## Measured

| What                                 | Value      | Notes                                                                                 |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------- |
| Stock VM boot to init                | ~930 ms    | CI kernel 6.1.155, nested KVM on WSL2, 50 ms poll granularity                         |
| XFS reflink of a 500 MB file         | 321 ms     | includes `cp` process start in an Alpine container                                    |
| InstanceStart → agent ping           | 412–464 ms | agent as PID 1 from squashfs, switch_root to ext4; kernel ~275 ms, init→listen ~60 ms |
| Reflink clone of a 32G sparse rootfs | 3 ms       | in the host container                                                                 |
| Checkpoint of a running imp          | 61–62 ms   | freeze (sync + FIFREEZE) + reflink + thaw, impd side; CLI round trip 89 ms            |
| Restore of a running imp             | 649–654 ms | graceful stop + reflink + rename + cold boot to agent ping                            |

## Next

- Merge wip/runtime (M6–M8), then finish `scripts/acceptance.sh` (M10).

## Blockers

None.

## Notes

- The dev box is WSL2 with nested virtualization. Expect bare metal to be faster.
- WSL 6.6 kernel: `mkfs.xfs` needs `-i nrext64=0,exchange=0 -n parent=0`.
- Guests use a custom 6.1.188 kernel (`kernel/build.sh`): the CI kernel lacks nftables and the
  iptables raw table that Docker 28+ needs. First build 8m35s; rebuilds about 32s.
