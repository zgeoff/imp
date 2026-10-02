# Guest kernel

The custom guest kernel for imp.
[Guest agent and kernel](../docs/architecture/agent.md#guest-kernel) says why imp builds its own and
what the config adds.

## Build

```sh
kernel/build.sh
```

Output: `kernel/out/vmlinux` (uncompressed ELF, what Firecracker x86_64 boots) and
`kernel/out/config`.

- Runs `make-vmlinux.sh` as your uid in the `kernel-builder` stage of `host/Dockerfile` (Ubuntu
  22.04, gcc 11, from a dated apt snapshot). No sudo. The release image builds its kernel with the
  same stage and script.
- Downloads `linux-$KVER.tar.xz` from kernel.org and checks its sha256. `kernel/version` holds
  `KVER` (6.1.188, 6.1 LTS) and `KSHA256`; change both there to bump. Override once with
  `KVER=... KSHA256=...`.
- Fixed `KBUILD_BUILD_*` values keep the build time, user and host out of the image, so the same
  sources and toolchain give the same bytes (`host/check-reproducible.sh`). The release kernel stage
  uses the same paths, so `kernel/out/vmlinux` matches the release image's.
- Sources and the object tree live in `kernel/.build/` (gitignored), so a rerun is incremental. On a
  16-core box: first build about 8.5 minutes, a config-only change about 30 seconds.
- The script exits non-zero if a symbol in the fragment does not reach the final config (unmet
  dependency or typo).

## Check

```sh
bash kernel/check-config.sh kernel/out/config
```

`check-config.sh` is moby's `contrib/check-config.sh`. Expected "missing" items: `SECURITY_APPARMOR`
and the zfs lines. Its cgroup section reads the machine you run it on, not the config file.
