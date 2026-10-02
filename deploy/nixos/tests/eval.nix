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
          # 6.18 LTS, which the pinned ZFS 2.4.4 builds for (a check below)
          boot.kernelPackages = pkgs.linuxPackages;
          services.imp.enable = true;
          services.imp.zfs.arcMaxMiB = 1024;
        }
        extra
      ];
    };

  failed = system: map (a: a.message) (lib.filter (a: !a.assertion) system.config.assertions);

  zfsHost = host {
    services.imp.tailscaleAuthKeyFile = "/run/secrets/imp-authkey";
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
  keyInSettings = host { services.imp.settings.TAILSCALE_AUTHKEY = "fake"; };
  noHostId = host { networking.hostId = lib.mkForce null; };
  ownWithNixosFirewall = host { services.imp.hostFirewall = "own"; };
  ownFirewall = host {
    services.imp.hostFirewall = "own";
    networking.firewall.enable = false;
    services.openssh.ports = [
      22
      2222
    ];
  };
  poolElsewhere = host { services.imp.zfs.importPool = false; };
  noArcCap = host { services.imp.zfs.arcMaxMiB = lib.mkForce null; };
  flushing = host {
    networking.nftables.enable = true;
    networking.nftables.flushRuleset = true;
  };

  zfsCfg = zfsHost.config;
  xfsCfg = xfsHost.config;
  unit = zfsCfg.systemd.services.imp-host;
  ownCfg = ownFirewall.config;
  sharedArgs = lib.escapeShellArgs (lib.flatten (lib.importJSON ../../imp-host.args.json).lines);

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
    (expect "the key may not go in settings" (
      lib.any (lib.hasInfix "sets TAILSCALE_AUTHKEY") (failed keyInSettings)
    ))
    (expect "zfs without a hostId is refused" (lib.any (lib.hasInfix "hostId") (failed noHostId)))
    (expect "own beside networking.firewall is refused" (
      lib.any (lib.hasInfix "two firewalls") (failed ownWithNixosFirewall)
    ))
    (expect "own without networking.firewall: no failed assertion" (failed ownFirewall == [ ]))
    (expect "own loads the imp table" (ownCfg.systemd.services ? imp-firewall))
    (expect "none loads no imp table" (!(zfsCfg.systemd.services ? imp-firewall)))
    (expect "the kernel's ZFS module builds" (!zfsCfg.boot.zfs.modulePackage.meta.broken))
    (expect "the ARC cap" (
      lib.hasInfix "options zfs zfs_arc_max=1073741824" zfsCfg.boot.extraModprobeConfig
    ))
    (expect "no arcMaxMiB, no modprobe line" (
      !(lib.hasInfix "zfs_arc_max" noArcCap.config.boot.extraModprobeConfig)
    ))
    (expect "a failing start stops after five tries" (unit.unitConfig.StartLimitBurst == 5))
    (expect "importPool = false imports nothing" (poolElsewhere.config.boot.zfs.extraPools == [ ]))
    (expect "the dataset waits for the pools" (
      lib.elem "zfs-import.target" zfsCfg.systemd.services.imp-zfs-dataset.after
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
    (expect "the args come from deploy/imp-host.args.json" (
      lib.hasInfix "/bin/docker run ${sharedArgs} " unit.serviceConfig.ExecStart
    ))
    (expect "the key file is mounted read-only, by path" (
      lib.hasInfix "-v /run/imp-host/tailscale-authkey:/run/imp/tailscale-authkey:ro -e 'IMP_TAILSCALE_AUTHKEY_FILE=/run/imp/tailscale-authkey'" unit.serviceConfig.ExecStart
    ))
    (expect "no key mount without a key file" (
      !(lib.hasInfix "tailscale-authkey" xfsCfg.systemd.services.imp-host.serviceConfig.ExecStart)
    ))
    (expect "no imp table on the host" (!(zfsCfg.networking.nftables.tables ? imp_host)))
    (expect "the platform firewall stays on" zfsCfg.networking.firewall.enable)
    (expect "ports on loopback only" (
      lib.hasInfix "-p 127.0.0.1:7070:7070 -p 127.0.0.1:7080:7080" unit.serviceConfig.ExecStart
    ))
  ];

  zfsPre = lib.head unit.serviceConfig.ExecStartPre;
  ownStart = ownCfg.systemd.services.imp-firewall.serviceConfig.ExecStart;
  ownPre = lib.head ownCfg.systemd.services.imp-host.serviceConfig.ExecStartPre;
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
  ! grep -q imp-authkey ${zfsPre}
  grep -qx 'export IMP_SECRETS=/run/secrets/imp-host.env' ${zfsPre}
  # own: bootstrap.sh's ruleset, for sshd's ports, and the env file says so
  rules=$(echo ${lib.escapeShellArg ownStart} | sed -n 's/.* -f //p')
  grep -qx '		tcp dport { 22, 2222 } accept comment "SSH"' "$rules"
  grep -q 'hook input priority filter; policy drop;' "$rules"
  grep -qx IMP_HOST_FIREWALL=own "$(settings ${ownPre})"
  printf '%s\n' ${lib.escapeShellArgs checks} > $out
''
