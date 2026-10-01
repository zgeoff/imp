# imp — status

Updated at each milestone. Newest state at the top of each section.

## Milestones

| #   | Milestone                                                                       | State       |
| --- | ------------------------------------------------------------------------------- | ----------- |
| M0  | Firecracker boots under nested KVM inside a privileged container                | done        |
| M1  | Walking skeleton: agent as PID 1 from a read-only system drive, exec over vsock | in progress |
| M2  | Workspace, API contract, db, addressing                                         | in progress |
| M3  | impd lifecycle: create, list, exec, console, destroy (CLI end to end)           | todo        |
| M4  | Images: OCI → ext4, images/base with Docker, images/dev, bring your own         | todo        |
| M5  | Checkpoint, restore, fork (XFS reflink)                                         | todo        |
| M6  | Sleep and wake (memory snapshot), idle detection, wake proxy                    | todo        |
| M7  | RAM governor (budget, LRU sleep), scale test                                    | todo        |
| M8  | Restart survival (re-adopt VMs, sleep on SIGTERM)                               | todo        |
| M9  | Tailscale                                                                       | todo        |
| M10 | `scripts/acceptance.sh` passes twice from a clean state                         | todo        |

## Measured

| What                         | Value   | Notes                                                         |
| ---------------------------- | ------- | ------------------------------------------------------------- |
| Stock VM boot to init        | ~930 ms | CI kernel 6.1.155, nested KVM on WSL2, 50 ms poll granularity |
| XFS reflink of a 500 MB file | 321 ms  | includes `cp` process start in an Alpine container            |

## Blockers

None.

## Notes

- The dev box is WSL2 with nested virtualization. Expect bare metal to be faster.
- WSL 6.6 kernel: `mkfs.xfs` needs `-i nrext64=0,exchange=0 -n parent=0`.
- Guests use a custom 6.1.188 kernel (`kernel/build.sh`): the CI kernel lacks nftables and the
  iptables raw table that Docker 28+ needs. First build 8m35s; rebuilds about 32s.
