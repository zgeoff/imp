# Evaluates nixosModules.imp on a few hosts, without booting one: the units,
# the kernel settings, the env file's keys, and the assertions that refuse a
# bad host. `cases` are nix-unit cases (the flake's `tests` output); `check`
# runs them in the build sandbox, then reads the generated files that only a
# build makes. `nix flake check` builds `check` as checks.eval; it needs no KVM.
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
          # 6.18 LTS, which the pinned ZFS 2.4.4 builds for (a case below)
          boot.kernelPackages = pkgs.linuxPackages;
          services.imp.enable = true;
          services.imp.zfs.arcMaxMiB = 1024;
        }
        extra
      ];
    };

  failed = system: map (a: a.message) (lib.filter (a: !a.assertion) system.config.assertions);

  # The module's refusal of a key that settings may not set.
  settingsRefusal =
    key:
    "services.imp.settings sets ${key}; use the module's options (image, storage, zfs.root, hostFirewall, tailscaleAuthKeyFile, backupPasswordFile, dnsApiTokenFile, publicPorts, egressDeny) instead";

  # Hosts that several cases read, and that `check` reads too. A host that one
  # case reads is written in that case.
  zfsHost = host {
    services.imp.tailscaleAuthKeyFile = "/run/secrets/imp-authkey";
    services.imp.environmentFile = "/run/secrets/imp-host.env";
    services.imp.backupPasswordFile = "/run/secrets/backup-password";
    services.imp.settings.IMP_TAILSCALE_HOSTNAME = "imp-test";
  };
  xfsHost = host {
    services.imp.storage = "xfs";
    fileSystems."/var/lib/imp" = {
      device = "/dev/vdb";
      fsType = "xfs";
    };
  };
  ownFirewall = host {
    services.imp.hostFirewall = "own";
    services.imp.egressDeny = [
      "203.0.113.7"
      "2001:db8:1::7/128"
    ];
    networking.firewall.enable = false;
    services.openssh.ports = [
      22
      2222
    ];
  };
  poolElsewhere = host { services.imp.zfs.importPool = false; };
  # As the cloud host has it: networking.firewall filters forwarding.
  ipv6Host = host {
    services.imp.ipv6.enable = true;
    services.imp.forwardDeny = [
      "10.42.0.0/16"
      "fd42::/64"
      "10.43.0.0/16"
    ];
    networking.nftables.enable = true;
    networking.firewall.filterForward = true;
    networking.defaultGateway6 = "2001:db8::1";
  };
  ipv6Kernel = host {
    services.imp.ipv6 = {
      enable = true;
      uplink = "eth0.100";
      routerAdverts = "kernel";
    };
    networking.dhcpcd.IPv6rs = false;
  };
  filterOnly = host {
    networking.nftables.enable = true;
    networking.firewall.filterForward = true;
  };
  dnsHost = host { services.imp.dnsApiTokenFile = "/run/secrets/imp-dns-api-token"; };

  zfsCfg = zfsHost.config;
  dnsCfg = dnsHost.config;
  dnsUnit = dnsCfg.systemd.services.imp-host;
  ipv6Cfg = ipv6Host.config;
  ipv6Unit = ipv6Cfg.systemd.services.imp-host;
  xfsCfg = xfsHost.config;
  unit = zfsCfg.systemd.services.imp-host;
  proxyUnit = zfsCfg.systemd.services.imp-docker-proxy;
  ownCfg = ownFirewall.config;
  hostArgs = lib.importJSON ../../imp-host.args.json;
  # The default image is the tag for package.json's version. The cases below
  # stop a return to :latest and keep the default tied to package.json; the
  # release chain makes that image exist (release-please bumps package.json,
  # release.yml pushes the tag, host/check-release-image.sh checks it).
  releaseImage = "ghcr.io/zgeoff/imp-host:${(lib.importJSON (self + "/package.json")).version}";
  # the env words ($IMP_PUBLIC_PORTS) are options, empty here; the env file
  # carries IMP_HOST_ADDRESSES, so the module leaves out the unit's -e
  addressesLine = [
    "-e"
    "IMP_HOST_ADDRESSES"
  ];
  sharedLines = lib.filter (line: line != addressesLine) hostArgs.lines;
  sharedArgs = lib.escapeShellArgs (
    lib.filter (word: !(lib.hasPrefix "$" word)) (lib.flatten sharedLines)
  );

  # nix-unit runs only the attributes whose names start with "test".
  cases = {
    "test a ZFS host passes every assertion" = {
      expr = failed zfsHost;
      expected = [ ];
    };
    "test an XFS host with a mount passes every assertion" = {
      expr = failed xfsHost;
      expected = [ ];
    };
    "test an XFS host without a mount is refused" = {
      expr = failed (host {
        services.imp.storage = "xfs";
      });
      expected = [
        "services.imp: with storage = \"xfs\", declare /var/lib/imp (XFS with reflink) in fileSystems"
      ];
    };
    "test settings may not set the module's keys" = {
      expr = failed (host {
        services.imp.settings.IMP_HOST_FIREWALL = "own";
      });
      expected = [ (settingsRefusal "IMP_HOST_FIREWALL") ];
    };
    "test settings may not hold the Tailscale key" = {
      expr = failed (host {
        services.imp.settings.TAILSCALE_AUTHKEY = "fake";
      });
      expected = [ (settingsRefusal "TAILSCALE_AUTHKEY") ];
    };
    # NixOS's ZFS module refuses it too; the order of the two is the module
    # system's, so the case sorts them.
    "test ZFS without a hostId is refused" = {
      expr = lib.sort lib.lessThan (
        failed (host {
          networking.hostId = lib.mkForce null;
        })
      );
      expected = [
        "ZFS requires networking.hostId to be set"
        "services.imp: ZFS needs networking.hostId, and a reinstall must keep the same one, or the pool will not import"
      ];
    };
    "test own beside networking.firewall is refused" = {
      expr = failed (host {
        services.imp.hostFirewall = "own";
      });
      expected = [
        "services.imp: hostFirewall = \"own\" needs networking.firewall.enable = false; two firewalls each drop what the other admits"
      ];
    };
    "test own without networking.firewall passes every assertion" = {
      expr = failed ownFirewall;
      expected = [ ];
    };
    "test own loads the imp table" = {
      expr = ownCfg.systemd.services ? imp-firewall;
      expected = true;
    };
    "test none loads no imp table" = {
      expr = zfsCfg.systemd.services ? imp-firewall;
      expected = false;
    };
    "test the kernel's ZFS module builds" = {
      expr = zfsCfg.boot.zfs.modulePackage.meta.broken;
      expected = false;
    };
    "test arcMaxMiB caps the ARC in modprobe" = {
      expr = lib.filter (lib.hasInfix "zfs_arc_max") (
        lib.splitString "\n" zfsCfg.boot.extraModprobeConfig
      );
      expected = [ "options zfs zfs_arc_max=1073741824" ];
    };
    "test no arcMaxMiB writes no ARC line" = {
      expr = lib.filter (lib.hasInfix "zfs_arc_max") (
        lib.splitString "\n"
          (host { services.imp.zfs.arcMaxMiB = lib.mkForce null; }).config.boot.extraModprobeConfig
      );
      expected = [ ];
    };
    "test a failing start stops after five tries" = {
      expr = unit.unitConfig.StartLimitBurst;
      expected = 5;
    };
    "test importPool = false imports nothing" = {
      expr = poolElsewhere.config.boot.zfs.extraPools;
      expected = [ ];
    };
    "test the pool imports by partuuid, which virtio disks have" = {
      expr = zfsCfg.boot.zfs.devNodes;
      expected = "/dev/disk/by-partuuid";
    };
    "test importPool = false keeps the default devNodes" = {
      expr = poolElsewhere.config.boot.zfs.devNodes;
      expected = "/dev/disk/by-id";
    };
    "test the dataset waits for the pools" = {
      expr = lib.elem "zfs-import.target" zfsCfg.systemd.services.imp-zfs-dataset.after;
      expected = true;
    };
    "test flushRuleset is refused" = {
      expr = failed (host {
        networking.nftables.enable = true;
        networking.nftables.flushRuleset = true;
      });
      expected = [
        "services.imp: networking.nftables.flushRuleset would flush Docker's rules on every reload; leave it false"
      ];
    };
    "test overcommit_memory is 1" = {
      expr = zfsCfg.boot.kernel.sysctl."vm.overcommit_memory";
      expected = 1;
    };
    "test swappiness is 1" = {
      expr = zfsCfg.boot.kernel.sysctl."vm.swappiness";
      expected = 1;
    };
    "test ZFS loads kvm, tun, loop and zfs" = {
      expr = lib.subtractLists zfsCfg.boot.kernelModules [
        "kvm"
        "tun"
        "loop"
        "zfs"
      ];
      expected = [ ];
    };
    "test XFS loads no zfs module" = {
      expr = lib.elem "zfs" xfsCfg.boot.kernelModules;
      expected = false;
    };
    "test the pool is imported" = {
      expr = zfsCfg.boot.zfs.extraPools;
      expected = [ "tank" ];
    };
    "test Docker is on" = {
      expr = zfsCfg.virtualisation.docker.enable;
      expected = true;
    };
    "test imp-host needs the dataset" = {
      expr = lib.elem "imp-zfs-dataset.service" unit.requires;
      expected = true;
    };
    "test imp-host wants the proxy" = {
      expr = lib.elem "imp-docker-proxy.service" unit.wants;
      expected = true;
    };
    "test imp-host starts after the proxy" = {
      expr = lib.elem "imp-docker-proxy.service" unit.after;
      expected = true;
    };
    "test imp-host needs its image" = {
      expr = lib.elem "imp-host-image.service" unit.requires;
      expected = true;
    };
    "test the proxy needs the image" = {
      expr = lib.elem "imp-host-image.service" proxyUnit.requires;
      expected = true;
    };
    "test the proxy starts after the image" = {
      expr = lib.elem "imp-host-image.service" proxyUnit.after;
      expected = true;
    };
    "test the default image is the module's own release" = {
      expr = zfsCfg.services.imp.image;
      expected = releaseImage;
    };
    "test the proxy gets the host image" = {
      expr = proxyUnit.environment.IMP_HOST_IMAGE;
      expected = releaseImage;
    };
    "test the proxy restarts always" = {
      expr = proxyUnit.serviceConfig.Restart;
      expected = "always";
    };
    "test imp-host binds no docker.sock" = {
      expr = lib.hasInfix "/var/run/docker.sock" unit.serviceConfig.ExecStart;
      expected = false;
    };
    "test imp-host reaches Docker through the proxy's socket" = {
      expr = lib.hasInfix "DOCKER_HOST=unix:///run/imp-docker/docker.sock" unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test imp-host runs docker run --init" = {
      expr = lib.hasPrefix "/bin/docker run --init " (
        lib.removePrefix "${zfsCfg.virtualisation.docker.package}" unit.serviceConfig.ExecStart
      );
      expected = true;
    };
    "test the args come from deploy/imp-host.args.json" = {
      expr = lib.hasInfix " ${sharedArgs} " unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test imp-host runs without --privileged" = {
      expr = lib.hasInfix "--privileged" unit.serviceConfig.ExecStart;
      expected = false;
    };
    "test the env file, not -e, carries IMP_HOST_ADDRESSES" = {
      expr = lib.hasInfix "-e IMP_HOST_ADDRESSES" unit.serviceConfig.ExecStart;
      expected = false;
    };
    "test the privileges come from deploy/imp-host.args.json" = {
      expr = lib.hasInfix "--cap-drop ALL --cap-add SYS_ADMIN" unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test the seccomp profile comes from the store" = {
      expr = lib.hasInfix "seccomp=/nix/store/" unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test imp-host gets the IPv6 sysctls by default" = {
      expr = lib.hasInfix "net.ipv6.conf.default.accept_ra=0" unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test ZFS passes /dev/zfs" = {
      expr = lib.hasInfix "--device /dev/zfs" unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test XFS passes no /dev/zfs" = {
      expr = lib.hasInfix "/dev/zfs" xfsCfg.systemd.services.imp-host.serviceConfig.ExecStart;
      expected = false;
    };
    "test publicPorts publish before the image" = {
      expr =
        lib.hasSuffix "-p 443:7443 -p 80:7480 ${releaseImage}"
          (host {
            services.imp.publicPorts = [
              "443:7443"
              "80:7480"
            ];
          }).config.systemd.services.imp-host.serviceConfig.ExecStart;
      expected = true;
    };
    "test the backup password is mounted read-only, by path" = {
      expr = lib.hasInfix "-v /run/imp-host/backup-password:/run/imp/backup-password:ro" unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test IMP_BACKUP_PASSWORD_FILE goes in backupPasswordFile, not settings" = {
      expr = failed (host {
        services.imp.settings.IMP_BACKUP_PASSWORD_FILE = "/x";
      });
      expected = [ (settingsRefusal "IMP_BACKUP_PASSWORD_FILE") ];
    };
    "test IMP_PUBLIC_PORTS goes in publicPorts, not settings" = {
      expr = failed (host {
        services.imp.settings.IMP_PUBLIC_PORTS = "-p 443:7443";
      });
      expected = [ (settingsRefusal "IMP_PUBLIC_PORTS") ];
    };
    "test IMP_EGRESS_DENY goes in egressDeny, not settings" = {
      expr = failed (host {
        services.imp.settings.IMP_EGRESS_DENY = "203.0.113.7";
      });
      expected = [ (settingsRefusal "IMP_EGRESS_DENY") ];
    };
    "test the key file is mounted read-only, by path" = {
      expr = lib.hasInfix "-v /run/imp-host/tailscale-authkey:/run/imp/tailscale-authkey:ro -e 'IMP_TAILSCALE_AUTHKEY_FILE=/run/imp/tailscale-authkey'" unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test no key file mounts no key" = {
      expr = lib.hasInfix "tailscale-authkey" xfsCfg.systemd.services.imp-host.serviceConfig.ExecStart;
      expected = false;
    };
    "test none puts no imp table on the host" = {
      expr = zfsCfg.networking.nftables.tables ? imp_host;
      expected = false;
    };
    "test the platform firewall stays on" = {
      expr = zfsCfg.networking.firewall.enable;
      expected = true;
    };
    "test the ports listen on loopback only" = {
      expr = lib.hasInfix "-p 127.0.0.1:7070:7070 -p 127.0.0.1:7080:7080" unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test an IPv6 host passes every assertion" = {
      expr = failed ipv6Host;
      expected = [ ];
    };
    "test with ipv6, imp-host joins the imp-host network" = {
      expr = lib.hasInfix "--env-file /etc/imp/imp-host.env --network imp-host " ipv6Unit.serviceConfig.ExecStart;
      expected = true;
    };
    "test without ipv6, imp-host runs on Docker's default bridge" = {
      expr = lib.hasInfix "--network" unit.serviceConfig.ExecStart;
      expected = false;
    };
    "test with ipv6, the network is made after the old container goes" = {
      expr = lib.hasSuffix "-imp-host-network" (toString (lib.last ipv6Unit.serviceConfig.ExecStartPre));
      expected = true;
    };
    "test with ipv6, the subnet is a unique local /64" = {
      expr = builtins.match "fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::/64" ipv6Cfg.services.imp.ipv6.subnet;
      expected = [ ];
    };
    "test denied ranges drop in their own chain, ahead of networking.firewall's, by family" = {
      expr = lib.hasInfix ''
        chain forward {
          type filter hook forward priority filter - 1; policy accept;
          iifname { "br-imphost", "docker0" } ip daddr { 10.42.0.0/16, 10.43.0.0/16 } ct direction original drop
          iifname { "br-imphost", "docker0" } ip6 daddr { fd42::/64 } ct direction original drop
        }'' ipv6Cfg.networking.nftables.tables.imp-forward.content;
      expected = true;
    };
    "test the denied ranges' table is inet" = {
      expr = ipv6Cfg.networking.nftables.tables.imp-forward.family;
      expected = "inet";
    };
    "test with ipv6, forwarding from imp-host's bridge alone is admitted" = {
      expr = ipv6Cfg.networking.firewall.extraForwardRules;
      expected = ''iifname { "br-imphost" } accept comment "imp: imp-host's egress"'';
    };
    "test no forwardDeny makes no table" = {
      expr = filterOnly.config.networking.nftables.tables ? imp-forward;
      expected = false;
    };
    "test br-imphost is not trusted for input" = {
      expr = lib.elem "br-imphost" ipv6Cfg.networking.firewall.trustedInterfaces;
      expected = false;
    };
    "test docker0 is not trusted for input" = {
      expr = lib.elem "docker0" ipv6Cfg.networking.firewall.trustedInterfaces;
      expected = false;
    };
    "test filterForward without ipv6 admits docker0 alone, with no deny" = {
      expr = filterOnly.config.networking.firewall.extraForwardRules;
      expected = ''iifname { "docker0" } accept comment "imp: imp-host's egress"'';
    };
    "test no forward filter writes no forward rules" = {
      expr = zfsCfg.networking.firewall.extraForwardRules;
      expected = "";
    };
    "test ipv6 without a way to keep router adverts is refused" = {
      expr = failed (host {
        services.imp.ipv6.enable = true;
      });
      expected = [
        "services.imp.ipv6: Docker turns on IPv6 forwarding, and with it on, router adverts that set the host's IPv6 default route are dropped unless something keeps them. Set one of: a static networking.defaultGateway6; services.imp.ipv6.uplink with a systemd.network.networks entry for it that sets networkConfig.IPv6AcceptRA = true; services.imp.ipv6.routerAdverts = \"kernel\" (with ipv6.uplink: accept_ra = 2); or services.imp.ipv6.routerAdverts = \"handled\" when your DHCP client keeps them"
      ];
    };
    "test networkd's IPv6AcceptRA on the uplink keeps router adverts" = {
      expr = failed (host {
        services.imp.ipv6 = {
          enable = true;
          uplink = "eth0";
        };
        systemd.network.networks."10-uplink" = {
          matchConfig.Name = "eth0";
          networkConfig.IPv6AcceptRA = true;
        };
      });
      expected = [ ];
    };
    "test kernel router adverts on an uplink pass every assertion" = {
      expr = failed ipv6Kernel;
      expected = [ ];
    };
    "test kernel router adverts set accept_ra 2 on the uplink, by the slash form" = {
      expr = ipv6Kernel.config.boot.kernel.sysctl."net/ipv6/conf/eth0.100/accept_ra";
      expected = 2;
    };
    "test kernel router adverts beside dhcpcd's soliciting are refused" = {
      expr = failed (host {
        services.imp.ipv6 = {
          enable = true;
          uplink = "eth0";
          routerAdverts = "kernel";
        };
      });
      expected = [
        "services.imp.ipv6.routerAdverts = \"kernel\": dhcpcd runs on eth0 and solicits router adverts itself, and may set accept_ra back. Set networking.dhcpcd.IPv6rs = false, or use \"handled\""
      ];
    };
    "test ipv6 with ip6tables off is refused" = {
      expr = failed (host {
        services.imp.ipv6 = {
          enable = true;
          routerAdverts = "handled";
        };
        virtualisation.docker.daemon.settings.ip6tables = false;
      });
      expected = [
        "services.imp.ipv6 needs Docker 27.0 or later with ip6tables on (virtualisation.docker.daemon.settings.ip6tables not false), which writes the network's NAT66 and forward rules"
      ];
    };
    "test kernel router adverts need the uplink" = {
      expr = failed (host {
        services.imp.ipv6 = {
          enable = true;
          routerAdverts = "kernel";
        };
      });
      expected = [
        "services.imp.ipv6.routerAdverts = \"kernel\" needs services.imp.ipv6.uplink, the interface to set accept_ra = 2 on"
      ];
    };
    "test forwardDeny without nftables is refused" = {
      expr = failed (host {
        services.imp.forwardDeny = [ "10.42.0.0/16" ];
      });
      expected = [ "services.imp.forwardDeny needs networking.nftables.enable = true, for its table" ];
    };
    "test a dnsApiTokenFile host passes every assertion" = {
      expr = failed dnsHost;
      expected = [ ];
    };
    "test the DNS token's directory is mounted read-only, and impd reads the token there" = {
      expr = lib.hasInfix "-v /run/imp-host/dns:/run/imp/dns:ro -e 'IMP_DNS_API_TOKEN_FILE=/run/imp/dns/token'" dnsUnit.serviceConfig.ExecStart;
      expected = true;
    };
    "test the DNS token is staged before each start" = {
      expr = lib.any (
        pre: lib.hasSuffix "-imp-host-dns-token" (toString pre)
      ) dnsUnit.serviceConfig.ExecStartPre;
      expected = true;
    };
    "test a change to the token file stages it again" = {
      expr = dnsCfg.systemd.paths.imp-host-dns-token.pathConfig.PathChanged;
      expected = "/run/secrets/imp-dns-api-token";
    };
    "test the token's path unit starts with the system" = {
      expr = lib.elem "multi-user.target" dnsCfg.systemd.paths.imp-host-dns-token.wantedBy;
      expected = true;
    };
    "test the token is staged again every 5 minutes" = {
      expr = dnsCfg.systemd.timers.imp-host-dns-token.timerConfig.OnUnitActiveSec;
      expected = "5min";
    };
    "test the token's timer starts with the timers" = {
      expr = lib.elem "timers.target" dnsCfg.systemd.timers.imp-host-dns-token.wantedBy;
      expected = true;
    };
    "test no DNS token file mounts no token directory" = {
      expr = lib.hasInfix "/run/imp/dns" unit.serviceConfig.ExecStart;
      expected = false;
    };
    "test no DNS token file makes no path unit" = {
      expr = zfsCfg.systemd.paths ? imp-host-dns-token;
      expected = false;
    };
    "test no DNS token file makes no timer" = {
      expr = zfsCfg.systemd.timers ? imp-host-dns-token;
      expected = false;
    };
    "test no DNS token file makes no staging service" = {
      expr = zfsCfg.systemd.services ? imp-host-dns-token;
      expected = false;
    };
    "test IMP_DNS_API_TOKEN_FILE goes in dnsApiTokenFile, not settings" = {
      expr = failed (host {
        services.imp.settings.IMP_DNS_API_TOKEN_FILE = "/x";
      });
      expected = [ (settingsRefusal "IMP_DNS_API_TOKEN_FILE") ];
    };
    "test IMP_HOST_NETWORK goes in ipv6.enable, not settings" = {
      expr = failed (host {
        services.imp.settings.IMP_HOST_NETWORK = "--network x";
      });
      expected = [ (settingsRefusal "IMP_HOST_NETWORK") ];
    };
  };

  # the env writer, among the secret staging and the image load
  writerOf =
    cfg:
    lib.findFirst (pre: lib.hasSuffix "-imp-host-env" (toString pre))
      (throw "no imp-host-env in ExecStartPre")
      cfg.systemd.services.imp-host.serviceConfig.ExecStartPre;
  zfsPre = writerOf zfsCfg;
  ownStart = ownCfg.systemd.services.imp-firewall.serviceConfig.ExecStart;
  ownPre = writerOf ownCfg;
  xfsPre = writerOf xfsCfg;
  ipv6Pre = writerOf ipv6Cfg;
  ipv6Network = lib.last ipv6Unit.serviceConfig.ExecStartPre;
  stagePre = lib.head unit.serviceConfig.ExecStartPre;
  dnsStage = dnsCfg.systemd.services.imp-host-dns-token.serviceConfig.ExecStart;
in
{
  inherit cases;

  check = pkgs.runCommand "imp-nixos-eval" { nativeBuildInputs = [ pkgs.nix-unit ]; } ''
    set -euo pipefail
    # The cases, in the sandbox against a store of nix-unit's own, as
    # nix-unit's flake-parts module runs them; the flake's one input comes
    # from the store, since the sandbox cannot fetch it.
    export HOME="$(realpath .)"
    unset NIX_STORE
    export NIX_STORE_DIR=${builtins.storeDir}
    export NIX_REMOTE="$HOME/storedata"
    nix-unit --show-trace \
      --extra-experimental-features "flakes pipe-operators" \
      --override-input nixpkgs ${nixpkgs} \
      --flake ${self}#tests 2>&1 | tee "$out"

    # The settings file is a store path; read it at build time. The trace
    # names the check that fails.
    set -x
    settings() { sed -n 's/^export IMP_SETTINGS=//p' "$1"; }
    # no match (1), and not a file that cannot be read (2)
    absent() { local rc=0; grep -q "$@" || rc=$?; [ "$rc" = 1 ]; }
    zfs=$(settings ${zfsPre})
    xfs=$(settings ${xfsPre})
    grep -qx IMP_HOST_FIREWALL=none "$zfs"
    grep -qx IMP_STORAGE_BACKEND=zfs "$zfs"
    grep -qx IMP_ZFS_ROOT=tank/imp "$zfs"
    grep -qx IMP_TAILSCALE_HOSTNAME=imp-test "$zfs"
    grep -qx IMP_STORAGE_BACKEND=xfs "$xfs"
    grep -qx IMP_ZFS_ROOT= "$xfs"
    # Secrets are named by path, read at start, and never in the store.
    absent TAILSCALE_AUTHKEY "$zfs"
    absent imp-authkey ${zfsPre}
    grep -qx 'export IMP_SECRETS=/run/secrets/imp-host.env' ${zfsPre}
    grep -qx 'export IMP_BACKUP_STAGED=/run/imp-host/backup-password' ${zfsPre}
    # the staging copies both secrets, by path
    grep -q "stage /run/secrets/imp-authkey /run/imp-host/tailscale-authkey" ${stagePre}
    grep -q "stage /run/secrets/backup-password /run/imp-host/backup-password" ${stagePre}
    # the DNS token: by path, into the mounted directory
    grep -q "imp-host-dns-token.sh /run/secrets/imp-dns-api-token /run/imp-host/dns" ${dnsStage}
    # own: bootstrap.sh's ruleset, for sshd's ports, and the env file says so
    rules=$(echo ${lib.escapeShellArg ownStart} | sed -n 's/.* -f //p')
    grep -qx '		tcp dport { 22, 2222 } accept comment "SSH"' "$rules"
    grep -q 'hook input priority filter; policy drop;' "$rules"
    grep -qx IMP_HOST_FIREWALL=own "$(settings ${ownPre})"
    grep -qx 'IMP_EGRESS_DENY=203.0.113.7,2001:db8:1::7/128' "$(settings ${ownPre})"
    grep -qx IMP_EGRESS_DENY= "$zfs"
    # ipv6: the env file says so, and the network script makes bootstrap.sh's network
    grep -qx IMP_HOST_IPV6=on "$(settings ${ipv6Pre})"
    grep -qx 'IMP_HOST_SUBNET6=${ipv6Cfg.services.imp.ipv6.subnet}' "$(settings ${ipv6Pre})"
    grep -qx IMP_HOST_IPV6=off "$zfs"
    grep -qx IMP_HOST_SUBNET6= "$zfs"
    grep -q 'create_host_network' ${ipv6Network}
    # the proxy: the args file's words, its socket's group read at start
    grep -qF -- '--group-add "$gid"' ${proxyUnit.serviceConfig.ExecStart}
    grep -qF -- "--cap-drop ALL --security-opt no-new-privileges --read-only" ${proxyUnit.serviceConfig.ExecStart}
    grep -qF -- "-v /var/run/docker.sock:/var/run/docker.sock" ${proxyUnit.serviceConfig.ExecStart}
    grep -qF -- "${releaseImage} /usr/local/bin/imp-docker-proxy" ${proxyUnit.serviceConfig.ExecStart}
    absent -- --env-file ${proxyUnit.serviceConfig.ExecStart}
    grep -q 'subnet6 ${ipv6Cfg.services.imp.ipv6.subnet}' ${ipv6Network}
  '';
}
