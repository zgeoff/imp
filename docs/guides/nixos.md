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
            # IMP_DNS_API_TOKEN, IMP_BACKUP_REPOSITORY, AWS_* and other secrets; root, 0400
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
  with `zfs.importPool` (the default) it adds the pool to `boot.zfs.extraPools`.
  `imp-zfs-dataset.service` runs after `zfs-import.target` and creates `zfs.root` (default
  `tank/imp`) with `mountpoint=legacy` only when it is missing. With `storage = "xfs"`, declare
  `/var/lib/imp` in `fileSystems`, as XFS with reflink; the module refuses the build without it.
- **`imp-host.service`:** runs the image with the arguments in
  [`deploy/imp-host.args.json`](../../deploy/imp-host.args.json), the same file
  [`deploy/imp-host.service`](../../deploy/imp-host.service) comes from. Before each start it writes
  `/etc/imp/imp-host.env` (0600), and loads `imageArchive` or pulls `image` when the image is
  missing. With ZFS, it needs `imp-zfs-dataset.service`.
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
  `IMP_STORAGE_BACKEND`, `IMP_ZFS_ROOT`, `IMP_HOST_FIREWALL`) and `TAILSCALE_AUTHKEY`, which the
  module refuses there. They are in the Nix store, so never put a secret here.
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
systemctl status imp-host imp-zfs-dataset
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
