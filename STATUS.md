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
| 9 mcp             | 11.3 s | 11.4 s |

Section 9 came after the acceptance runs, with the MCP server (#20); its times are from two runs on
2026-10-02 against the same dev box, with `E2E_RAM_BUDGET_MIB=2048`.

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

Backups, from the `backups` e2e suite on the dev box (MinIO in the dev instance's network):

| What                                     | Value               |
| ---------------------------------------- | ------------------- |
| First run: 2 imps, 1 checkpoint, 1 image | 31–45 s             |
| Next run: 1 imp running, 1 stopped       | 10–14 s             |
| Data added, first and next run           | 150–178 / 15–19 MiB |
| Restore of an imp with one checkpoint    | 3.9–4.1 s           |

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
| `ssh` to a sleeping imp, to output   | 185–194 ms                | wake about 104 ms; e2e-tiny and a 512 MiB ubuntu imp  |
| `scp` 200 MB up / down               | 1.7 s / 1.1 s             | to a 512 MiB ubuntu imp, through the SSH gateway      |

## Known gaps

- An upgrade across an agent change was tested on the dev instance (`scripts/dev.sh down`, then `up`
  on a new drive), not on a server with `deploy/upgrade.sh`. A new Firecracker or host kernel still
  boots every sleeping imp cold ([#10](https://github.com/zgeoff/imp/issues/10)).
- On a host kernel before Linux 6.7, an `imp sleep` within 1.5 s of a cold boot waits up to about
  1.2 s first; without the wait the next wake takes 0.75–1.1 s. A governor sleep does not wait, so
  its victim's next wake can be that slow
  ([young guests](docs/architecture/sleep-and-wake.md#young-guests),
  [#33](https://github.com/zgeoff/imp/issues/33)). `scripts/bench-wake.sh` has not run on a host
  with the fix yet.
- The ZFS storage backend ([#11](https://github.com/zgeoff/imp/issues/11)) has unit tests against a
  fake zfs and a CI job against a pool on a file, but no run on a real host yet. Its checkpoint,
  restore, fork and sleep times are not measured; `scripts/zfs-host-test.sh` measures them.
- Backups ([#12](https://github.com/zgeoff/imp/issues/12)): a known cost, kept for now: restic reads
  every hole of a 32 GiB sparse disk, about 10 s of CPU for each disk it has to read in a run. The
  restore drill passed on XFS on the dev box; on ZFS it runs in the zfs CI job only. MinIO for the
  drill comes from Chainguard's free `:latest`, pinned by digest, which Chainguard may stop serving.
  Memory snapshots are not backed up: a sleeping imp comes back stopped.
- HTTPS on a domain ([#16](https://github.com/zgeoff/imp/issues/16)) is tested against Pebble only
  (the `https` suite: certificate in about 100 ms, an imp over https, a wake over https), not with a
  real domain, Let's Encrypt or Cloudflare. Cloudflare is the only real DNS provider, and public
  exposure (`imp url --public`) is not built ([#52](https://github.com/zgeoff/imp/issues/52)).
- No jailer and no inner container in the guest yet ([#27](https://github.com/zgeoff/imp/issues/27),
  [#28](https://github.com/zgeoff/imp/issues/28)).
- Credential connectors ([#15](https://github.com/zgeoff/imp/issues/15)) reach execs only: services
  in `/etc/imp/services.d` get no broker variables, and a tool that ignores `HTTPS_PROXY` or keeps
  its own trust store bypasses the broker ([connectors](./docs/guides/connectors.md#limits)).
- Scoped tokens and tailnet identity ([#29](https://github.com/zgeoff/imp/issues/29)): the `tokens`
  e2e suite (3.5–4.8 s) checks scopes and imp patterns through the CLI. The `tailscale` suite's
  tailnet identity case passed once on the dev box (suite 31.4 s with it), with a rule for any
  member. SSH logins still go by `authorized_keys` only: every key there has `exec` on every imp,
  and keys tied to scoped tokens are not built.
- The base image's dockerd wrapper still clears stale `/run` files, which the agent's `/run` tmpfs
  already prevents ([#5](https://github.com/zgeoff/imp/issues/5) removes it).

## Notes

- The dev box is WSL2 with nested virtualization. Expect bare metal to be faster.
- WSL 6.6 kernel: `mkfs.xfs` needs `-i nrext64=0,exchange=0 -n parent=0`.
- WSL's uplink MTU is 1360; `setup-net.sh` clamps guest TCP MSS to match.
- Guests use a custom 6.1.188 kernel: the CI kernel lacks nftables and the iptables raw table that
  Docker 28+ needs.
