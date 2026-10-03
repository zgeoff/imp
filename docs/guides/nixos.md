# NixOS

imp's flake exports `nixosModules.imp`, which sets a NixOS host up for the `imp-host` container. It
meets the [host contract](../architecture/host-contract.md), as
[`deploy/bootstrap.sh`](./install.md#bootstrap-a-server) does on Ubuntu and Debian. The module is
[`deploy/nixos/module.nix`](../../deploy/nixos/module.nix).

## Use it

```nix
{
  inputs.imp.url = "github:zgeoff/imp";
  # The module takes pkgs from your system; imp's own pin is for its checks only.
  inputs.imp.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, imp, ... }: {
    nixosConfigurations.server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        imp.nixosModules.imp
        {
          networking.hostId = "8425e349"; # ZFS needs one, and a reinstall must keep it
          services.imp = {
            enable = true;
            storage = "zfs"; # the default
            zfs.pool = "tank"; # imported at boot; imp gets tank/imp
            zfs.arcMaxMiB = 6400; # optional: 10 % of 64 GB, within 1 to 8 GiB, as bootstrap.sh picks
            settings.IMP_TAILSCALE_HOSTNAME = "imp";
            tailscaleAuthKeyFile = "/var/lib/imp-host/secrets/tailscale-authkey"; # root, 0400
            backupPasswordFile = "/var/lib/imp-host/secrets/backup-password"; # root, 0400
            dnsApiTokenFile = "/var/lib/imp-host/secrets/dns-api-token"; # root, 0400; with IMP_DOMAIN
            # IMP_BACKUP_REPOSITORY, AWS_* and other secrets; root, 0400
            environmentFile = "/var/lib/imp-host/secrets/imp-host.env";
          };
        }
      ];
    };
  };
}
```

Use a kernel that the system's ZFS builds for. The module's checks use nixpkgs' default,
`pkgs.linuxPackages` (6.18 LTS with ZFS 2.4.4 at the pinned nixpkgs).

## What it sets

- **Docker:** `virtualisation.docker.enable`.
- **Kernel:** `vm.overcommit_memory = 1`, `vm.swappiness = 1`, and the modules `kvm`, `tun` and
  `loop`. With ZFS, also `zfs`, `boot.supportedFilesystems.zfs`, and the ARC cap (`zfs.arcMaxMiB`)
  in `boot.extraModprobeConfig`.
- **Storage:** the module expects the pool and never creates it. It needs `networking.hostId`, and
  with `zfs.importPool` (the default) it adds the pool to `boot.zfs.extraPools`, and imports it by
  `/dev/disk/by-partuuid` (`boot.zfs.devNodes`, a default you can override): virtio disks have no
  serial, so `/dev/disk/by-id` has no link to them and the import finds the pool `MISSING`.
  `imp-zfs-dataset.service` runs after `zfs-import.target` and creates `zfs.root` (default
  `tank/imp`) with `mountpoint=legacy` only when it is missing. With `storage = "xfs"`, declare
  `/var/lib/imp` in `fileSystems`, as XFS with reflink; the module refuses the build without it.
- **`imp-host.service`:** runs the image with the arguments in
  [`deploy/imp-host.args.json`](../../deploy/imp-host.args.json), the same file
  [`deploy/imp-host.service`](../../deploy/imp-host.service) comes from. Before each start it writes
  `/etc/imp/imp-host.env` (0600). `imp-host-image.service` loads `imageArchive`, or pulls `image`
  when the image is missing, before each start of either container. With ZFS, it needs
  `imp-zfs-dataset.service`.
- **`imp-docker-proxy.service`:** the only Docker socket imp-host sees, from the `proxy` section of
  the same file ([the Docker socket](../architecture/host-contract.md#the-docker-socket)). imp-host
  wants it and starts after it; a proxy that stops fails image work only. It closes the Docker
  socket path only: `SYS_ADMIN` still lets root out of the container. The module and the image must
  come from the same release: pin `inputs.imp` and `image` (or `imageArchive`) together. The module
  runs the image without `--privileged`, so an image from before that change
  ([#75](https://github.com/zgeoff/imp/issues/75)) fails at start, in `setup-storage`.
- **Public imps:** `publicPorts`, such as `[ "443:7443" "80:7480" ]`, publishes the public
  listeners, as `IMP_PUBLIC_PORTS` does for the systemd unit
  ([public imps](./https.md#public-imps)). Set `IMP_PUBLIC_IP` in `settings`, and open the ports in
  `networking.firewall`. The module refuses `IMP_PUBLIC_PORTS` in `settings`.
- **Firewall:** `hostFirewall`, by default `none`. The env file says `IMP_HOST_FIREWALL=none`,
  `networking.firewall` stays the host's firewall, and imp adds no host rules; it needs no inbound
  port ([Firewall](../architecture/host-contract.md#firewall)). With `own`, the module loads
  `bootstrap.sh`'s `imp_host` table for `services.openssh.ports`, and refuses the build unless
  `networking.firewall.enable = false`. Either way it refuses
  `networking.nftables.flushRuleset = true`, which would flush Docker's rules.
- **Forwarding:** with `networking.firewall.filterForward = true` (nftables), the firewall drops new
  forwarded traffic that no rule admits, and so imps' egress. The module adds
  `iifname { "br-imphost" } accept` to `networking.firewall.extraForwardRules`, or `docker0` without
  IPv6: imp-host's bridge alone, so other containers on `docker0` need rules of their own. It trusts
  no interface: `trustedInterfaces` would also open every host service, such as the k3s API, to imp
  traffic. `forwardDeny` drops ranges that imps may not reach through the host
  ([IPv6 and forwarding](#ipv6)).

## IPv6

`ipv6.enable` runs `imp-host` on the Docker network `imp-host`, with the /64 `ipv6.subnet` and the
bridge `br-imphost`, as `bootstrap.sh --ipv6 on` does ([IPv6](./install.md#ipv6)). By default
`ipv6.subnet` is a unique local /64 from a hash of `networking.hostId`. The env file says
`IMP_HOST_IPV6=on`. Before each start, the module creates the network when it is missing, and
creates it again when it differs and nothing else is on it. Without IPv6, it removes a network that
an earlier generation made. Turning IPv6 off cold-boots every imp that has an IPv6 prefix.

```nix
services.imp = {
  ipv6.enable = true;
  # with networkd: the uplink's IPv6AcceptRA = true is enough; else say who keeps router adverts
  ipv6.uplink = "eth0";
  ipv6.routerAdverts = "kernel"; # or "handled"
  forwardDeny = [ "10.42.0.0/16" "10.43.0.0/16" ]; # k3s pods and services
};
networking.nftables.enable = true;
networking.firewall.filterForward = true;
```

Docker turns on IPv6 forwarding for the network, and with forwarding on, router adverts that set the
host's IPv6 default route can be dropped ([the caution](./install.md#ipv6)). The module refuses
`ipv6.enable` unless one of these keeps the route:

- a static `networking.defaultGateway6`;
- systemd-networkd with `networkConfig.IPv6AcceptRA = true` on the network that matches
  `ipv6.uplink`;
- `ipv6.routerAdverts = "kernel"`: the kernel takes them, and the module sets `accept_ra = 2` on
  `ipv6.uplink`. NixOS's dhcpcd solicits router adverts itself and may set `accept_ra` back, so the
  module refuses `kernel` while dhcpcd runs on the uplink, unless
  `networking.dhcpcd.IPv6rs = false`;
- `ipv6.routerAdverts = "handled"`: a client such as dhcpcd (the NixOS default) or NetworkManager
  takes them, and you checked that its config keeps them with forwarding on. The module cannot check
  that: run `ip -6 route show default` half an hour after `imp-host` starts, past a router advert's
  lifetime, and look for the route.

The module also refuses `ipv6.enable` with a Docker older than 27.0, or with
`virtualisation.docker.daemon.settings.ip6tables = false`: Docker then writes no NAT66 for the
network.

Docker also sets the `ip6tables` FORWARD policy to DROP when it turns forwarding on. A host where
other services forward IPv6, such as dual-stack k3s, needs their own accept rules or
`virtualisation.docker.daemon.settings.ip-forward-no-drop = true`.

`forwardDeny` takes IPv4 and IPv6 ranges that traffic from `br-imphost` and `docker0` may not reach
through the host. They drop in the nftables table `imp-forward`, a forward chain that runs before
`networking.firewall`'s, so ICMPv6, which that chain accepts first, drops too. Only new flows drop
(`ct direction original`): the replies of a flow that started in a denied range, such as a k3s pod
that reaches a public imp, pass. It needs `networking.nftables.enable`. Set it to a k3s cluster's
pod and service ranges, for example, instead of hand-written `docker0` rules.

## Reinstall

A reinstall keeps the pool, and the imps and node state in it:

- Keep `networking.hostId`. A pool records the host that last imported it, and a new hostId makes
  the import refuse it.
- Never let disko, or any disk layout tool, format the pool's disk. Leave that disk out of the
  layout, and let the module import the pool.
- impd's database lives on the pool too: setup-storage mounts `<pool>/imp` on `/var/lib/imp` before
  impd starts. A database that is lost or older than the pool leaves disks it does not name; impd
  keeps and logs them ([storage cleanup](./operations.md#storage-cleanup)).

## The env file

`/etc/imp/imp-host.env` is written again at each start of `imp-host`, so edit the module's options,
not the file:

- `settings`: any [variable](./configuration.md) but the module's own keys (`IMP_HOST_IMAGE`,
  `IMP_STORAGE_BACKEND`, `IMP_ZFS_ROOT`, `IMP_HOST_FIREWALL`, `IMP_HOST_IPV6`, `IMP_HOST_SUBNET6`),
  `IMP_HOST_NETWORK`, `TAILSCALE_AUTHKEY` and `IMP_DNS_API_TOKEN_FILE`, which the module refuses
  there. They are in the Nix store, so never put a secret here.
- `environmentFile`: a file outside the store, such as a sops or agenix secret, copied in at each
  start.
- `IMP_RAM_BUDGET_MIB`: `ramBudgetMiB`, else measured at each start, as `bootstrap.sh` does, less
  the ARC cap ([RAM](../architecture/host-contract.md#ram)). When the formula gives less than 512
  MiB, `imp-host` refuses to start and logs the RAM and the formula: set `ramBudgetMiB`. A start
  that keeps failing stops after five tries in five minutes.
- The ARC cap: `zfs.arcMaxMiB`, set through `boot.extraModprobeConfig` so it holds from boot. Do not
  also set `zfs_arc_max` in your own `boot.extraModprobeConfig` or `boot.kernelParams`: two values
  clash, and the budget counts only `arcMaxMiB`. Unset, each start keeps a cap that is already set,
  or else sets bootstrap.sh's 10 % of RAM within 1 to 8 GiB.

## Backups

`backupPasswordFile` names the restic repository password, outside the Nix store
([backups](../architecture/backups.md)). Keep it at `/var/lib/imp-host/secrets/backup-password`,
owned by root, mode 0400. Like the Tailscale key, a copy goes to `/run/imp-host` before each start
and is mounted read-only into the container at `/run/imp/backup-password`, and
`IMP_BACKUP_PASSWORD_FILE` names it; the password never goes into the env file. A missing or empty
file only warns, and the module blanks `IMP_BACKUP_REPOSITORY`, so backups stay off. Put
`IMP_BACKUP_REPOSITORY` and the `AWS_*` keys in `environmentFile`, such as
`/var/lib/imp-host/secrets/imp-host.env` (root, 0400).

## The DNS API token

`dnsApiTokenFile` names a file outside the Nix store that holds the DNS provider's API token
([HTTPS](./https.md#the-token-in-a-file)), such as `/var/lib/imp-host/secrets/dns-api-token` (root,
0400). It replaces `IMP_DNS_API_TOKEN` in `environmentFile`: remove that line when you set it, as
impd refuses to start with both.

impd reads the token at each DNS call, so a new one must reach the running container. The module
copies the file into the directory `/run/imp-host/dns` and mounts the directory read-only at
`/run/imp/dns`, and `IMP_DNS_API_TOKEN_FILE` names `/run/imp/dns/token`. A mounted file would keep
the old token after a copy; a mounted directory sees each new file, renamed in. The copy is made:

- before each start of `imp-host`;
- when the file changes (`imp-host-dns-token.path`, with `PathChanged`);
- every 5 minutes (`imp-host-dns-token.timer`), for what `PathChanged` misses, such as a symlink
  that now points at a new file.

Each run copies only a token that changed, and never replaces a staged token with a file that is
missing or empty: a secrets manager that drops the file for a moment does not take HTTPS down. With
no token at all, `imp-host` still starts; impd logs the path, `imp info` shows the error, and
certificates and DNS records wait for the token.

With sops-nix, have a new secret run the copy at once instead of at the next timer:

```nix
sops.secrets.imp-dns-api-token = {
  path = "/var/lib/imp-host/secrets/dns-api-token";
  restartUnits = [ "imp-host-dns-token.service" ];
};
```

## The Tailscale key

`tailscaleAuthKeyFile` names a file outside the Nix store that holds a tagged auth key
([Tailscale](./tailscale.md)). Keep it at `/var/lib/imp-host/secrets/tailscale-authkey`, owned by
root, mode 0400: `/var/lib/imp-host` is the module's own directory (0700), and a reinstall with
nixos-anywhere can put the file there with `--extra-files`. The key never goes into the env file or
the store. At each start the module copies it to `/run/imp-host` and mounts the copy read-only into
the container at `/run/imp/tailscale-authkey`, and `tailscale-up.sh` in the container decides when
to use it ([how it works](./tailscale.md#how-it-works)):

- With node state in the pool, `tailscaled` comes back from it, and the key is not used.
- With no state, or a saved node that needs a login, `tailscale` joins with the key. An ephemeral
  node that stays offline long enough is deleted by Tailscale, and a reinstall can take that long,
  so keep a valid key in the file if the host may be down for a while.
- A missing or empty key file only warns, and the node comes back from its saved state. The module
  always mounts its own copy, so docker never meets a missing source; where something else mounts
  the key, note that docker turns a missing source into an empty directory, which `tailscale-up.sh`
  also ignores.
- A saved node still `Starting` after 15 s, as on a boot with no network yet, counts as good: the
  container starts, and `tailscale-up.sh` waits for it in the background, joining with the key only
  if it turns out to need a login.
- A key that Tailscale refuses, such as a single-use key that joined once already, fails the join
  with a message that says so. `imp-host` keeps running without the tailnet; it does not restart in
  a loop. Put a new key in the file and restart `imp-host`.

## Check it

```sh
systemctl status imp-docker-proxy imp-host imp-zfs-dataset
docker exec imp-host imp info
docker exec imp-host imp new check --image ubuntu && docker exec imp-host imp exec check -- uname -a
docker exec imp-host imp rm check
```

## Test it

`nix flake check` runs two checks:

- `eval` builds the module for ZFS and XFS hosts and checks the units, the kernel settings, the env
  file's keys and the refusals. It needs no KVM.
- `vm` boots two NixOS VMs with the module, as `scripts/test-bootstrap.sh --stub` does for
  `bootstrap.sh`. One has a ZFS pool on a second disk and a stand-in image that runs the real
  `tailscale-up.sh` against a fake `tailscale`. It checks the env file, the kernel settings, that
  the host has no imp firewall rules, and the three ways the node comes up: a first join with the
  key, a restart from good state with no key, and a join again when the saved node needs a login.
  The other has `hostFirewall = "own"`: SSH connects through the imp table, and another port does
  not. It needs KVM, with nesting, and boots no imp.

Without Nix on the machine, run them in a container, with `/dev/kvm` and no `--privileged`; the
store stays in a Docker volume:

```sh
docker run --rm --device /dev/kvm -v imp-nix:/nix -v "$PWD:$PWD" -w "$PWD" \
  -e NIX_CONFIG=$'experimental-features = nix-command flakes\nsystem-features = kvm nixos-test' \
  nixos/nix sh -c 'git config --global --add safe.directory "*" && nix flake check -L'
```

In a git worktree, also mount the main checkout's `.git` at its own path. Nix sees only the files
git tracks, so `git add` new files first. CI runs the same checks in the `nix` workflow when
`flake.nix`, `flake.lock`, `deploy/` or `host/scripts/tailscale-up.sh` change.
