# NixOS

imp's flake exports `nixosModules.imp`, which sets a NixOS host up for the `imp-host` container. It
meets the [host contract](../architecture/host-contract.md), as
[`deploy/bootstrap.sh`](./install.md#bootstrap-a-server) does on Ubuntu and Debian. The module is
[`deploy/nixos/module.nix`](../../deploy/nixos/module.nix).

## Use it

```nix
{
  inputs.imp.url = "github:zgeoff/imp";

  outputs = { nixpkgs, imp, ... }: {
    nixosConfigurations.server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        imp.nixosModules.imp
        {
          networking.hostId = "8425e349"; # ZFS needs one: head -c 8 /etc/machine-id
          services.imp = {
            enable = true;
            storage = "zfs"; # the default
            zfs.pool = "tank"; # imported at boot; imp gets tank/imp
            settings.IMP_TAILSCALE_HOSTNAME = "imp";
            tailscale.authKeyFile = "/run/secrets/imp-tailscale-authkey";
            environmentFile = "/run/secrets/imp-host.env"; # IMP_DNS_API_TOKEN and other secrets
          };
        }
      ];
    };
  };
}
```

## What it sets

- **Docker:** `virtualisation.docker.enable`.
- **Kernel:** `vm.overcommit_memory = 1`, `vm.swappiness = 1`, and the modules `kvm`, `tun` and
  `loop`. With ZFS, also `zfs`, `boot.supportedFilesystems.zfs` and `boot.zfs.extraPools`.
- **Storage:** with ZFS, `imp-zfs-dataset.service` creates `zfs.root` (default `tank/imp`) with
  `mountpoint=legacy` once the pool is imported. The module never creates the pool; make it by hand
  or with your disk layout tool. With `storage = "xfs"`, declare `/var/lib/imp` in `fileSystems`, as
  XFS with reflink; the module refuses the build without it.
- **`imp-host.service`:** runs the image with the flags of
  [`deploy/imp-host.service`](../../deploy/imp-host.service). Before each start it writes
  `/etc/imp/imp-host.env` (0600), and loads `imageArchive` or pulls `image` when the image is
  missing. With ZFS, it needs `imp-zfs-dataset.service`.
- **Firewall:** none. The env file says `IMP_HOST_FIREWALL=none`, and `networking.firewall` stays
  the host's firewall. imp needs no inbound port on the host
  ([Firewall](../architecture/host-contract.md#firewall)). The module refuses
  `networking.nftables.flushRuleset = true`, which would flush Docker's rules.

## The env file

`/etc/imp/imp-host.env` is written again at each start of `imp-host`, so edit the module's options,
not the file:

- `settings`: the module's keys (`IMP_HOST_IMAGE`, `IMP_STORAGE_BACKEND`, `IMP_ZFS_ROOT`,
  `IMP_HOST_FIREWALL`) and any [other variable](./configuration.md). They are in the Nix store, so
  never put a secret here.
- `environmentFile`: a file outside the store, such as a sops or agenix secret, copied in at each
  start.
- `IMP_RAM_BUDGET_MIB`: `ramBudgetMiB`, else measured at each start, as `bootstrap.sh` does
  ([RAM](../architecture/host-contract.md#ram)). `zfs.arcMaxMiB` sets the ARC cap the same way.

## The Tailscale key

`tailscale.authKeyFile` names a file outside the Nix store that holds a tagged auth key
([Tailscale](./tailscale.md)). The module copies the key into the env file only until the node
joins. `imp-host-tailscale.service` waits for the node to be `Running`, then leaves
`/var/lib/imp-host/tailscale-joined` and restarts `imp-host` without the key. The node state in
`/var/lib/imp/tailscale` keeps it on the tailnet from then on. Remove the key from your secrets once
the node has joined. To join again, delete the marker and give a new key.

The module cannot see the node state before the container starts, because the ZFS dataset mounts
inside it. On a pool that already holds node state, such as one an earlier `bootstrap.sh` run set
up, leave `authKeyFile` unset, or create the marker before the first start.

## Check it

```sh
systemctl status imp-host imp-zfs-dataset
docker exec imp-host imp info
docker exec imp-host imp new check --image ubuntu && docker exec imp-host imp exec check -- uname -a
docker exec imp-host imp rm check
```

## Test it

`nix flake check` runs two checks:

- `eval` builds the module for ZFS and XFS hosts and checks the units, the kernel settings, the env
  file's keys and the refusals. It needs no KVM.
- `vm` boots a NixOS VM with the module, a ZFS pool on a second disk, and a stand-in image, as
  `scripts/test-bootstrap.sh --stub` does for `bootstrap.sh`. It checks the env file, the key's
  single use, the kernel settings, and that the host has no imp firewall rules. It needs KVM, with
  nesting, and boots no imp.

Without Nix on the machine, run them in a container; the store stays in a Docker volume:

```sh
docker run --rm --device /dev/kvm -v imp-nix:/nix -v "$PWD:$PWD" -w "$PWD" \
  -e NIX_CONFIG=$'experimental-features = nix-command flakes\nsystem-features = kvm nixos-test' \
  nixos/nix sh -c 'git config --global --add safe.directory "*" && nix flake check -L'
```

In a git worktree, also mount the main checkout's `.git` at its own path. Nix sees only the files
git tracks, so `git add` new files first. CI runs the same checks in the `nix` workflow when
`flake.nix`, `flake.lock` or `deploy/` change.
