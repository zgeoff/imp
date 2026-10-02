# imp — status

Measurements, known gaps and notes for the current build. The [docs](./docs/README.md) describe how
it works.

## Milestones

The first build reached every milestone by 2026-10-02: Firecracker under nested KVM (M0), the
walking skeleton (M1), the workspace and API (M2), the lifecycle (M3), images (M4), checkpoints and
forks (M5), sleep and wake (M6), the RAM governor (M7), restart survival (M8), Tailscale (M9), and
two clean acceptance runs (M10). The [roadmap](https://github.com/zgeoff/imp/issues/41) tracks what
comes next.

## Acceptance

The acceptance run passed twice in a row from a clean state on 2026-10-02 (WSL2 dev box, nested
KVM), with the script that `scripts/test-e2e.sh` has since replaced. Each section below is now the
harness suite with the same number: shell is `lifecycle`, byo-image is `images`, checkpoint-fork is
`checkpoints`, sleep-wake is `sleep`, and the rest keep their names.

| Section           | Run 1  | Run 2  |
| ----------------- | ------ | ------ |
| 0 setup           | 24.3 s | 23.5 s |
| 1 shell           | 3.6 s  | 3.4 s  |
| 2 docker          | 8.9 s  | 8.5 s  |
| 3 byo-image       | 5.8 s  | 5.7 s  |
| 4 checkpoint-fork | 4.0 s  | 3.9 s  |
| 5 sleep-wake      | 14.5 s | 14.9 s |
| 6 scale           | 75.5 s | 75.2 s |
| 7 restart         | 9.2 s  | 12.3 s |
| 8 tailscale       | 6.4 s  | 4.4 s  |

Scale test (section 6): RAM budget 6144 MiB, 30 imps of 512 MiB, each filling 256 MiB of tmpfs. At
most 19 imps were awake at once; 21–22 were asleep after all 30 existed. Peak usage was 3167–3168
MiB as measured by impd and 3170–3204 MiB as independent Firecracker PSS. The budget held at every
one of about 122 samples.

## Measured

From the two acceptance runs:

| What                             | Run 1                | Run 2                |
| -------------------------------- | -------------------- | -------------------- |
| `imp new` + first exec           | 683 ms               | 588 ms               |
| Create (30 imps) p50 / p95 / max | 589 / 1207 / 1223 ms | 589 / 1230 / 3334 ms |
| Wake (30 imps) p50 / p95 / max   | 282 / 1641 / 5845 ms | 291 / 1307 / 4586 ms |
| HTTP request that wakes an imp   | 141 ms               | 99 ms                |
| Per-imp RAM (256 MiB filled)     | 317 MiB              | 317 MiB              |
| Idle → asleep (timeout 10 s)     | 9.2 s                | 9.7 s                |
| RAM freed by sleep (idle imp)    | 90 MiB               | 88 MiB               |
| Checkpoint of a running imp      | 95 ms                | 100 ms               |
| Restore of a running imp         | 653 ms               | 632 ms               |
| Live fork + boot                 | 633 ms               | 647 ms               |
| impd restart                     | 1.4 s                | 4.6 s                |

The long wake tail in the scale test comes from waking 30 imps one after another while the governor
sleeps others to make room, on a nested-virtualization host.

From the milestone work:

| What                                 | Value                     | Notes                                                 |
| ------------------------------------ | ------------------------- | ----------------------------------------------------- |
| InstanceStart → agent ping           | 431–482 ms                | custom kernel; kernel ~275 ms, init → listen ~60 ms   |
| Reflink clone of a 32G sparse rootfs | 3 ms                      | in the host container                                 |
| dockerd ready after the agent ping   | 0.7–1.3 s                 | images/base                                           |
| Idle base imp with dockerd           | 348 MiB host RSS          | 2 GiB guest; 567 MiB with nginx running               |
| Idle 512 MiB guest, no dockerd       | 58–66 MiB                 | anonymous memory, the governor's measure              |
| Wake inside impd                     | 59–101 ms                 | load 30–55 ms + agent 21–40 ms; pages fault in lazily |
| Sleep, 512 MiB guest                 | 0.5–2.1 s                 | memory file 50–60 MiB on disk after `--dig-holes`     |
| Sleep every imp on SIGTERM           | 1.7–2.5 s                 | 5 imps                                                |
| Free page reporting                  | 988 → 91 MiB RSS          | ~15 s after the guest frees 900 MiB                   |
| Image sizes (unpacked)               | base 490 MiB, dev 1.7 GiB |                                                       |
| Guest kernel build                   | 8m35s first, ~32 s again  | `kernel/build.sh`                                     |

## Known gaps

- An upgrade across an agent change was tested on the dev instance (`scripts/dev.sh down`, then `up`
  on a new drive), not on a server with `deploy/upgrade.sh`. A new Firecracker or host kernel still
  boots every sleeping imp cold ([#10](https://github.com/zgeoff/imp/issues/10)).
- A wake right after another wake or exec (under about 1 s apart) takes 650–850 ms instead of about
  80 ms. Normal idle timeouts never hit it ([#33](https://github.com/zgeoff/imp/issues/33)).
- No jailer and no inner container in the guest yet ([#27](https://github.com/zgeoff/imp/issues/27),
  [#28](https://github.com/zgeoff/imp/issues/28)).
- The base image's dockerd wrapper still clears stale `/run` files, which the agent's `/run` tmpfs
  already prevents ([#5](https://github.com/zgeoff/imp/issues/5) removes it).

## Notes

- The dev box is WSL2 with nested virtualization. Expect bare metal to be faster.
- WSL 6.6 kernel: `mkfs.xfs` needs `-i nrext64=0,exchange=0 -n parent=0`.
- WSL's uplink MTU is 1360; `setup-net.sh` clamps guest TCP MSS to match.
- Guests use a custom 6.1.188 kernel: the CI kernel lacks nftables and the iptables raw table that
  Docker 28+ needs.
