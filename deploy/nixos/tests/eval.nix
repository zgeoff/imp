# Evaluates nixosModules.imp on a few hosts, without booting one: the units,
# the kernel settings, the env file's keys, and the assertions that refuse a
# bad host. `nix flake check` builds it; it needs no KVM.
{
  nixpkgs,
  pkgs,
  self,
}:

let
  lib = pkgs.lib;

  host =
    extra:
    nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        self.nixosModules.imp
        {
          boot.loader.grub.enable = false;
          fileSystems."/" = {
            device = "/dev/vda";
            fsType = "ext4";
          };
          networking.hostId = "8425e349";
          system.stateVersion = "26.05";
          services.imp.enable = true;
        }
        extra
      ];
    };

  failed = system: map (a: a.message) (lib.filter (a: !a.assertion) system.config.assertions);

  zfsHost = host {
    services.imp.tailscale.authKeyFile = "/run/secrets/imp-authkey";
    services.imp.environmentFile = "/run/secrets/imp-host.env";
    services.imp.settings.IMP_TAILSCALE_HOSTNAME = "imp-test";
  };
  xfsHost = host {
    services.imp.storage = "xfs";
    fileSystems."/var/lib/imp" = {
      device = "/dev/vdb";
      fsType = "xfs";
    };
  };
  xfsNoMount = host { services.imp.storage = "xfs"; };
  overriding = host { services.imp.settings.IMP_HOST_FIREWALL = "own"; };
  flushing = host {
    networking.nftables.enable = true;
    networking.nftables.flushRuleset = true;
  };

  zfsCfg = zfsHost.config;
  xfsCfg = xfsHost.config;
  unit = zfsCfg.systemd.services.imp-host;

  expect = name: cond: if cond then name else throw "eval check failed: ${name}";
  checks = [
    (expect "zfs: no failed assertion" (failed zfsHost == [ ]))
    (expect "xfs with a mount: no failed assertion" (failed xfsHost == [ ]))
    (expect "xfs without a mount is refused" (
      lib.any (lib.hasInfix "declare /var/lib/imp") (failed xfsNoMount)
    ))
    (expect "settings may not set the module's keys" (
      lib.any (lib.hasInfix "sets IMP_HOST_FIREWALL") (failed overriding)
    ))
    (expect "flushRuleset is refused" (lib.any (lib.hasInfix "flushRuleset") (failed flushing)))
    (expect "sysctls" (
      zfsCfg.boot.kernel.sysctl."vm.overcommit_memory" == 1
      && zfsCfg.boot.kernel.sysctl."vm.swappiness" == 1
    ))
    (expect "modules" (
      lib.all (m: lib.elem m zfsCfg.boot.kernelModules) [
        "kvm"
        "tun"
        "loop"
        "zfs"
      ]
    ))
    (expect "xfs loads no zfs" (!(lib.elem "zfs" xfsCfg.boot.kernelModules)))
    (expect "the pool is imported" (zfsCfg.boot.zfs.extraPools == [ "tank" ]))
    (expect "docker" zfsCfg.virtualisation.docker.enable)
    (expect "imp-host needs the dataset" (lib.elem "imp-zfs-dataset.service" unit.requires))
    (expect "the key unit exists with a key file" (zfsCfg.systemd.services ? imp-host-tailscale))
    (expect "no key unit without one" (!(xfsCfg.systemd.services ? imp-host-tailscale)))
    (expect "no imp table on the host" (!(zfsCfg.networking.nftables.tables ? imp_host)))
    (expect "the platform firewall stays on" zfsCfg.networking.firewall.enable)
    (expect "ports on loopback only" (
      lib.hasInfix "-p 127.0.0.1:7070:7070 -p 127.0.0.1:7080:7080" unit.serviceConfig.ExecStart
    ))
  ];

  zfsPre = lib.head unit.serviceConfig.ExecStartPre;
  xfsPre = lib.head xfsCfg.systemd.services.imp-host.serviceConfig.ExecStartPre;
in
# The settings file is a store path; read it at build time.
pkgs.runCommand "imp-nixos-eval" { } ''
  set -euo pipefail
  settings() { sed -n 's/^export IMP_SETTINGS=//p' "$1"; }
  zfs=$(settings ${zfsPre})
  xfs=$(settings ${xfsPre})
  grep -qx IMP_HOST_FIREWALL=none "$zfs"
  grep -qx IMP_STORAGE_BACKEND=zfs "$zfs"
  grep -qx IMP_ZFS_ROOT=tank/imp "$zfs"
  grep -qx IMP_TAILSCALE_HOSTNAME=imp-test "$zfs"
  grep -qx IMP_STORAGE_BACKEND=xfs "$xfs"
  grep -qx IMP_ZFS_ROOT= "$xfs"
  # Secrets are named by path, read at start, and never in the store.
  ! grep -q TAILSCALE_AUTHKEY "$zfs"
  grep -qx 'export IMP_AUTHKEY_FILE=/run/secrets/imp-authkey' ${zfsPre}
  grep -qx 'export IMP_SECRETS=/run/secrets/imp-host.env' ${zfsPre}
  printf '%s\n' ${lib.escapeShellArgs checks} > $out
''
