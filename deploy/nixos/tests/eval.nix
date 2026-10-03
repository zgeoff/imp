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
  publicHost = host {
    services.imp.publicPorts = [
      "443:7443"
      "80:7480"
    ];
  };
  backupInSettings = host { services.imp.settings.IMP_BACKUP_PASSWORD_FILE = "/x"; };
  publicPortsInSettings = host { services.imp.settings.IMP_PUBLIC_PORTS = "-p 443:7443"; };
  poolElsewhere = host { services.imp.zfs.importPool = false; };
  noArcCap = host { services.imp.zfs.arcMaxMiB = lib.mkForce null; };
  flushing = host {
    networking.nftables.enable = true;
    networking.nftables.flushRuleset = true;
  };
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
  ipv6NoRoute = host { services.imp.ipv6.enable = true; };
  ipv6Kernel = host {
    services.imp.ipv6 = {
      enable = true;
      uplink = "eth0.100";
      routerAdverts = "kernel";
    };
    networking.dhcpcd.IPv6rs = false;
  };
  ipv6KernelDhcpcd = host {
    services.imp.ipv6 = {
      enable = true;
      uplink = "eth0";
      routerAdverts = "kernel";
    };
  };
  ipv6NoIp6tables = host {
    services.imp.ipv6 = {
      enable = true;
      routerAdverts = "handled";
    };
    virtualisation.docker.daemon.settings.ip6tables = false;
  };
  ipv6KernelNoUplink = host {
    services.imp.ipv6 = {
      enable = true;
      routerAdverts = "kernel";
    };
  };
  ipv6Networkd = host {
    services.imp.ipv6 = {
      enable = true;
      uplink = "eth0";
    };
    systemd.network.networks."10-uplink" = {
      matchConfig.Name = "eth0";
      networkConfig.IPv6AcceptRA = true;
    };
  };
  filterOnly = host {
    networking.nftables.enable = true;
    networking.firewall.filterForward = true;
  };
  denyNoNftables = host { services.imp.forwardDeny = [ "10.42.0.0/16" ]; };
  networkInSettings = host { services.imp.settings.IMP_HOST_NETWORK = "--network x"; };

  zfsCfg = zfsHost.config;
  ipv6Cfg = ipv6Host.config;
  ipv6Unit = ipv6Cfg.systemd.services.imp-host;
  ipv6Rules = ipv6Cfg.networking.firewall.extraForwardRules;
  xfsCfg = xfsHost.config;
  unit = zfsCfg.systemd.services.imp-host;
  proxyUnit = zfsCfg.systemd.services.imp-docker-proxy;
  ownCfg = ownFirewall.config;
  hostArgs = lib.importJSON ../../imp-host.args.json;
  # the image release.yml pushes for this checkout's version
  releaseImage = "ghcr.io/zgeoff/imp-host:${(lib.importJSON (self + "/package.json")).version}";
  # the env words ($IMP_PUBLIC_PORTS) are options, empty here
  sharedArgs = lib.escapeShellArgs (
    lib.filter (word: !(lib.hasPrefix "$" word)) (lib.flatten hostArgs.lines)
  );

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
    (expect "the pool imports by partuuid, which virtio disks have" (
      zfsCfg.boot.zfs.devNodes == "/dev/disk/by-partuuid"
    ))
    (expect "importPool = false keeps the default devNodes" (
      poolElsewhere.config.boot.zfs.devNodes == "/dev/disk/by-id"
    ))
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
    (expect "imp-host wants the proxy and starts after it" (
      lib.elem "imp-docker-proxy.service" unit.wants && lib.elem "imp-docker-proxy.service" unit.after
    ))
    (expect "both containers start after their image is there" (
      lib.elem "imp-host-image.service" unit.requires
      && lib.elem "imp-host-image.service" proxyUnit.requires
      && lib.elem "imp-host-image.service" proxyUnit.after
    ))
    (expect "the default image is the module's own release" (zfsCfg.services.imp.image == releaseImage))
    (expect "the proxy gets the host image and restarts always" (
      proxyUnit.environment.IMP_HOST_IMAGE == releaseImage && proxyUnit.serviceConfig.Restart == "always"
    ))
    (expect "imp-host binds no docker.sock" (
      !(lib.hasInfix "/var/run/docker.sock" unit.serviceConfig.ExecStart)
      && lib.hasInfix "DOCKER_HOST=unix:///run/imp-docker/docker.sock" unit.serviceConfig.ExecStart
    ))
    (expect "the args come from deploy/imp-host.args.json" (
      lib.hasPrefix "/bin/docker run --init " (
        lib.removePrefix "${zfsCfg.virtualisation.docker.package}" unit.serviceConfig.ExecStart
      )
      && lib.hasInfix " ${sharedArgs} " unit.serviceConfig.ExecStart
    ))
    (expect "no --privileged" (!(lib.hasInfix "--privileged" unit.serviceConfig.ExecStart)))
    (expect "the privileges come from deploy/imp-host.args.json" (
      lib.hasInfix "--cap-drop ALL --cap-add SYS_ADMIN" unit.serviceConfig.ExecStart
    ))
    (expect "the seccomp profile comes from the store" (
      lib.hasInfix "seccomp=/nix/store/" unit.serviceConfig.ExecStart
    ))
    (expect "IPv6 sysctls by default" (
      lib.hasInfix "net.ipv6.conf.default.accept_ra=0" unit.serviceConfig.ExecStart
    ))
    (expect "zfs passes /dev/zfs" (lib.hasInfix "--device /dev/zfs" unit.serviceConfig.ExecStart))
    (expect "xfs passes no /dev/zfs" (
      !(lib.hasInfix "/dev/zfs" xfsCfg.systemd.services.imp-host.serviceConfig.ExecStart)
    ))
    (expect "publicPorts publish before the image" (
      lib.hasSuffix "-p 443:7443 -p 80:7480 ${releaseImage}" publicHost.config.systemd.services.imp-host.serviceConfig.ExecStart
    ))
    (expect "the backup password is mounted read-only, by path" (
      lib.hasInfix "-v /run/imp-host/backup-password:/run/imp/backup-password:ro" unit.serviceConfig.ExecStart
    ))
    (expect "IMP_BACKUP_PASSWORD_FILE goes in backupPasswordFile, not settings" (
      lib.any (lib.hasInfix "sets IMP_BACKUP_PASSWORD_FILE") (failed backupInSettings)
    ))
    (expect "IMP_PUBLIC_PORTS goes in publicPorts, not settings" (
      lib.any (lib.hasInfix "sets IMP_PUBLIC_PORTS") (failed publicPortsInSettings)
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
    (expect "ipv6: no failed assertion" (failed ipv6Host == [ ]))
    (expect "ipv6: imp-host joins the imp-host network" (
      lib.hasInfix "--env-file /etc/imp/imp-host.env --network imp-host " ipv6Unit.serviceConfig.ExecStart
    ))
    (expect "no ipv6: Docker's default bridge" (
      !(lib.hasInfix "--network" unit.serviceConfig.ExecStart)
    ))
    (expect "ipv6: the network is made after the old container goes" (
      lib.hasSuffix "-imp-host-network" (toString (lib.last ipv6Unit.serviceConfig.ExecStartPre))
    ))
    (expect "ipv6: a unique local /64 from the hostId" (
      builtins.match "fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::/64" ipv6Cfg.services.imp.ipv6.subnet != null
    ))
    (expect "ipv6: denied ranges drop in their own chain, ahead of networking.firewall's, by family" (
      lib.hasInfix ''
        chain forward {
          type filter hook forward priority filter - 1; policy accept;
          iifname { "br-imphost", "docker0" } ip daddr { 10.42.0.0/16, 10.43.0.0/16 } ct direction original drop
          iifname { "br-imphost", "docker0" } ip6 daddr { fd42::/64 } ct direction original drop
        }'' ipv6Cfg.networking.nftables.tables.imp-forward.content
      && ipv6Cfg.networking.nftables.tables.imp-forward.family == "inet"
    ))
    (expect "ipv6: forwarding from imp-host's bridge alone is admitted" (
      ipv6Rules == ''iifname { "br-imphost" } accept comment "imp: imp-host's egress"''
    ))
    (expect "no forwardDeny, no table" (!(filterOnly.config.networking.nftables.tables ? imp-forward)))
    (expect "no bridge is trusted for input" (
      !(lib.elem "br-imphost" ipv6Cfg.networking.firewall.trustedInterfaces)
      && !(lib.elem "docker0" ipv6Cfg.networking.firewall.trustedInterfaces)
    ))
    (expect "filterForward without ipv6: docker0 alone, no deny" (
      filterOnly.config.networking.firewall.extraForwardRules
      == ''iifname { "docker0" } accept comment "imp: imp-host's egress"''
    ))
    (expect "no forward filter, no forward rules" (zfsCfg.networking.firewall.extraForwardRules == ""))
    (expect "ipv6 without a way to keep router adverts is refused" (
      lib.any (lib.hasInfix "router adverts") (failed ipv6NoRoute)
    ))
    (expect "networkd's IPv6AcceptRA on the uplink keeps them" (failed ipv6Networkd == [ ]))
    (expect "kernel router adverts: accept_ra 2 on the uplink, by the slash form" (
      failed ipv6Kernel == [ ]
      && ipv6Kernel.config.boot.kernel.sysctl."net/ipv6/conf/eth0.100/accept_ra" == 2
    ))
    (expect "kernel router adverts beside dhcpcd's soliciting are refused" (
      lib.any (lib.hasInfix "dhcpcd runs on eth0") (failed ipv6KernelDhcpcd)
    ))
    (expect "ipv6 with ip6tables off is refused" (
      lib.any (lib.hasInfix "Docker 27.0 or later with ip6tables on") (failed ipv6NoIp6tables)
    ))
    (expect "kernel router adverts need the uplink" (
      lib.any (lib.hasInfix "needs services.imp.ipv6.uplink") (failed ipv6KernelNoUplink)
    ))
    (expect "forwardDeny without nftables is refused" (
      lib.any (lib.hasInfix "forwardDeny needs networking.nftables.enable") (failed denyNoNftables)
    ))
    (expect "IMP_HOST_NETWORK goes in ipv6.enable, not settings" (
      lib.any (lib.hasInfix "sets IMP_HOST_NETWORK") (failed networkInSettings)
    ))
  ];

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
  grep -qx 'export IMP_BACKUP_STAGED=/run/imp-host/backup-password' ${zfsPre}
  # the staging copies both secrets, by path
  grep -q "stage /run/secrets/imp-authkey /run/imp-host/tailscale-authkey" ${stagePre}
  grep -q "stage /run/secrets/backup-password /run/imp-host/backup-password" ${stagePre}
  # own: bootstrap.sh's ruleset, for sshd's ports, and the env file says so
  rules=$(echo ${lib.escapeShellArg ownStart} | sed -n 's/.* -f //p')
  grep -qx '		tcp dport { 22, 2222 } accept comment "SSH"' "$rules"
  grep -q 'hook input priority filter; policy drop;' "$rules"
  grep -qx IMP_HOST_FIREWALL=own "$(settings ${ownPre})"
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
  if grep -q -- --env-file ${proxyUnit.serviceConfig.ExecStart}; then exit 1; fi
  grep -q 'subnet6 ${ipv6Cfg.services.imp.ipv6.subnet}' ${ipv6Network}
  printf '%s\n' ${lib.escapeShellArgs checks} > $out
''
