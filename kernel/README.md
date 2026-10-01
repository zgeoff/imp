# Guest kernel

imp guests run Docker. The Firecracker CI kernel (6.1.155, `.cache/vmlinux-ci.config`) boots, but it
cannot run a current docker-ce well:

- No `CONFIG_NF_TABLES`. Ubuntu 24.04 `iptables` is iptables-nft by default, so a stock image fails
  until you switch it to iptables-legacy.
- No `CONFIG_IP_NF_RAW` / `CONFIG_IP6_NF_RAW`. Docker 28+ writes raw-table PREROUTING rules to block
  direct access to container IPs.
- No `CONFIG_NETFILTER_XT_MARK`, `CONFIG_NETFILTER_XT_MATCH_IPVS` (listed as required by moby's
  `check-config.sh`), no `TUN`, no `FUSE_FS`.

The CI kernel is built with `CONFIG_MODULES` off and guests have no initramfs, so the missing parts
cannot be loaded later. We build our own kernel.

## Build

```sh
kernel/build.sh
```

Output: `kernel/out/vmlinux` (uncompressed ELF, what Firecracker x86_64 boots) and
`kernel/out/config`.

- Runs in a Docker container (Ubuntu 22.04, gcc 11) as your uid. No sudo.
- Downloads `linux-$KVER.tar.xz` from kernel.org and checks its sha256. Default `KVER=6.1.188` (6.1
  LTS). Override with `KVER=... KSHA256=...`.
- Sources and the object tree live in `kernel/.build/` (gitignored), so a rerun is incremental. On a
  16-core box: first build about 8.5 minutes, a config-only change about 30 seconds.
- The script exits non-zero if a symbol in the fragment does not reach the final config (unmet
  dependency or typo).

## How the config is made

1. `config-base`: Firecracker's microvm config (copy of the CI 6.1.155 config).
2. `docker.fragment`: merged on top with `scripts/kconfig/merge_config.sh -m`.
3. `make olddefconfig` fills symbols that are new in the newer 6.1 release.

Every fragment entry is `=y`. Do not add `=m`: nothing loads modules.

## What the fragment adds

- nftables: `NF_TABLES`, `NF_TABLES_INET/IPV4/IPV6/BRIDGE/NETDEV`, `NFT_COMPAT` (iptables-nft xt
  matches), `NFT_NAT`, `NFT_MASQ`, `NFT_CT`, `NFT_FIB*`, `NFT_REJECT*` and friends.
- iptables: raw and security tables, `XT_MARK`/`CONNMARK`, `XT_SET` + ipset, `CHECKSUM`, `CT`,
  `NOTRACK`, extra matches (ipvs, bpf, multiport, physdev, comment, owner, recent, statistic),
  ebtables, FTP/TFTP conntrack helpers.
- IPVS (round robin, TCP/UDP) for Swarm and kube-proxy ipvs mode.
- Network drivers: `VLAN_8021Q` + `BRIDGE_VLAN_FILTERING`, `VXLAN`, `IPVLAN`, `MACVLAN`, `DUMMY`,
  `TUN`, `WIREGUARD`, `NET_CLS_CGROUP`, `IP_SCTP`, ESP/GCM for encrypted overlay.
- `CGROUP_MISC`, `FUSE_FS` + `CUSE`, `BTRFS_FS`.
- Pins the Firecracker essentials already in the base (virtio mmio/blk/net, virtio-balloon +
  `PAGE_REPORTING`, vsock, squashfs xz/zstd, ext4, `IKCONFIG_PROC`) so a base change cannot drop
  them.

AppArmor stays off on purpose. With AppArmor active, dockerd expects `apparmor_parser` and profiles
inside the guest image.

## Check

```sh
bash kernel/check-config.sh kernel/out/config
```

`check-config.sh` is moby's `contrib/check-config.sh`. Expected "missing" items: `SECURITY_APPARMOR`
and the zfs lines. Note: its cgroup section reads the machine you run it on, not the config file.
