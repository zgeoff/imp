# The imp host on NixOS: what deploy/bootstrap.sh does on Ubuntu and Debian,
# as a module. imp's flake exports it as nixosModules.imp. The host contract
# is in docs/architecture/host-contract.md; the guide is docs/guides/nixos.md.
#
# The module takes pkgs from the system that imports it and never imports
# nixpkgs itself; the flake's own pin is for its checks.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.imp;
  docker = "${config.virtualisation.docker.package}/bin/docker";
  zfs = cfg.storage == "zfs";
  ownFirewall = cfg.hostFirewall == "own";
  ipv6 = cfg.ipv6.enable;
  # bootstrap.sh's names: the network imp-host runs on with IPv6, and its
  # bridge, which the forward rules below name.
  hostNetwork = "imp-host";
  hostBridge = "br-imphost";

  # The docker run arguments, shared with deploy/imp-host.service and
  # bootstrap.sh (scripts/render-imp-host.ts writes those two from it). A
  # $NAME word is env-file words in the unit, and an option here.
  hostArgs = lib.importJSON ../imp-host.args.json;
  # the seccomp profile from the store, not /etc/imp
  seccomp = "seccomp=${../imp-host.seccomp.json}";
  privileges = map (
    word: if word == "seccomp=/etc/imp/imp-host.seccomp.json" then seccomp else word
  ) (lib.flatten hostArgs.privileges);
  envWords = {
    "$IMP_PUBLIC_PORTS" = lib.concatMap (port: [
      "-p"
      port
    ]) cfg.publicPorts;
    "$IMP_HOST_NETWORK" = lib.optionals ipv6 [
      "--network"
      hostNetwork
    ];
  };
  sharedArgs = lib.concatMap (
    word:
    if lib.hasPrefix "$" word then
      envWords.${word}
        or (throw "services.imp: deploy/imp-host.args.json has ${word}, which the module has no option for")
    else
      [ word ]
  ) (lib.flatten hostArgs.lines);
  # The unit probes for each path; the module knows from its config. A new
  # probed path fails evaluation here until it gets a condition.
  probedWhen = {
    "/dev/zfs" = zfs;
    "/proc/sys/net/ipv6" = config.networking.enableIPv6;
  };
  probedArgs = lib.concatMap (
    entry: lib.optionals probedWhen.${entry.path} entry.args
  ) hostArgs.probed;
  stateDir = "/var/lib/imp-host";
  # Secret files outside the store: each is copied before every start to
  # /run/imp-host (0400) and the copy is mounted read-only, so a missing
  # source never stops docker run; the copy is then empty, which the reader
  # treats as no secret. The Tailscale key is read by tailscale inside the
  # container only when the node has to join (host/scripts/tailscale-up.sh);
  # the backup password by restic, through IMP_BACKUP_PASSWORD_FILE, which
  # imp-host-env.sh sets only when the copy holds one.
  secrets = lib.filter (secret: secret.source != null) [
    {
      name = "tailscale-authkey";
      source = cfg.tailscaleAuthKeyFile;
      env = "IMP_TAILSCALE_AUTHKEY_FILE";
      missing = "the node starts from its saved state and cannot join again without a key";
    }
    {
      name = "backup-password";
      source = cfg.backupPasswordFile;
      env = null;
      missing = "backups stay off";
    }
  ];
  stagedPath = name: "/run/imp-host/${name}";
  containerPath = name: "/run/imp/${name}";
  secretArgs = lib.concatMap (
    secret:
    [
      "-v"
      "${stagedPath secret.name}:${containerPath secret.name}:ro"
    ]
    ++ lib.optionals (secret.env != null) [
      "-e"
      "${secret.env}=${containerPath secret.name}"
    ]
  ) secrets;
  stageSecrets = pkgs.writeShellScript "imp-host-secrets" ''
    set -euo pipefail
    export PATH=${lib.makeBinPath [ pkgs.coreutils ]}
    install -d -m 0700 /run/imp-host
    stage() {
      if [ -f "$1" ] && [ -s "$1" ] && [ -r "$1" ]; then
        install -m 0400 "$1" "$2"
      else
        install -m 0400 /dev/null "$2"
        echo "imp-host: $1 is missing or empty; $3" >&2
      fi
    }
    ${lib.concatMapStrings (secret: ''
      stage ${lib.escapeShellArg secret.source} ${stagedPath secret.name} ${lib.escapeShellArg secret.missing}
    '') secrets}
  '';
  # The DNS API token, staged on its own: impd reads it at each DNS call,
  # so a new token must reach the running container. The container mounts
  # the directory, where imp-host-dns-token.sh renames each new copy in; a
  # bind-mounted file would keep its old inode.
  dnsToken = cfg.dnsApiTokenFile != null;
  dnsStageDir = "/run/imp-host/dns";
  dnsContainerDir = "/run/imp/dns";
  dnsArgs = lib.optionals dnsToken [
    "-v"
    "${dnsStageDir}:${dnsContainerDir}:ro"
    "-e"
    "IMP_DNS_API_TOKEN_FILE=${dnsContainerDir}/token"
  ];
  stageDnsToken = pkgs.writeShellScript "imp-host-dns-token" ''
    export PATH=${
      lib.makeBinPath [
        pkgs.coreutils
        pkgs.diffutils
        pkgs.gnugrep
      ]
    }
    exec ${pkgs.bash}/bin/bash ${./imp-host-dns-token.sh} ${lib.escapeShellArg cfg.dnsApiTokenFile} ${dnsStageDir}
  '';
  runArgs = privileges ++ probedArgs ++ sharedArgs ++ secretArgs ++ dnsArgs ++ [ cfg.image ];

  # imp-docker-proxy (deploy/imp-docker-proxy.service): the only Docker
  # socket imp-host sees. It closes the Docker socket path only: imp-host
  # keeps SYS_ADMIN, which still lets root out of the container. It runs as
  # 65534 and joins the group of the host's socket, read at each start.
  proxyWord =
    word:
    if word == "$IMP_DOCKER_GID" then
      ''"$gid"''
    else if lib.hasPrefix "$" word then
      throw "services.imp: the proxy section of deploy/imp-host.args.json has ${word}, which the module has no value for"
    else
      lib.escapeShellArg word;
  proxyWords = lib.flatten hostArgs.proxy.privileges ++ lib.flatten hostArgs.proxy.lines;
  runProxy = pkgs.writeShellScript "imp-docker-proxy-run" ''
    set -euo pipefail
    gid=$(${pkgs.coreutils}/bin/stat -c %g /var/run/docker.sock)
    exec ${docker} run ${
      lib.concatMapStringsSep " " proxyWord proxyWords
    } ${lib.escapeShellArg cfg.image} ${lib.escapeShellArgs hostArgs.proxy.command}
  '';
  # The socket's directory and the proxy's token, owned by its user. Not
  # RuntimeDirectory: a stop would remove the directory under imp-host's
  # bind mount. A socket a crash left would pass the wait below.
  proxyDirs = pkgs.writeShellScript "imp-docker-proxy-dirs" ''
    set -euo pipefail
    ${pkgs.coreutils}/bin/install -d -m 0700 -o 65534 -g 65534 /run/imp-docker /var/lib/imp-docker-proxy
    ${pkgs.coreutils}/bin/rm -f /run/imp-docker/docker.sock
  '';
  waitProxy = pkgs.writeShellScript "imp-docker-proxy-wait" ''
    for _ in $(${pkgs.coreutils}/bin/seq 300); do
      [ -S /run/imp-docker/docker.sock ] && exit 0
      ${pkgs.coreutils}/bin/sleep 0.1
    done
    echo "imp-docker-proxy: no socket after 30 s" >&2
    exit 1
  '';

  # The module's own keys; settings may not set them (an assertion below).
  # No secret goes here: it is in the Nix store.
  moduleSettings = {
    IMP_HOST_IMAGE = cfg.image;
    IMP_STORAGE_BACKEND = cfg.storage;
    IMP_ZFS_ROOT = if zfs then cfg.zfs.root else "";
    IMP_HOST_FIREWALL = cfg.hostFirewall;
    IMP_HOST_IPV6 = if ipv6 then "on" else "off";
    IMP_HOST_SUBNET6 = lib.optionalString ipv6 cfg.ipv6.subnet;
  };
  overridden = lib.attrNames (
    lib.intersectAttrs (
      moduleSettings
      // {
        TAILSCALE_AUTHKEY = "";
        IMP_PUBLIC_PORTS = "";
        IMP_HOST_NETWORK = "";
        IMP_BACKUP_PASSWORD_FILE = "";
        IMP_DNS_API_TOKEN_FILE = "";
      }
    ) cfg.settings
  );
  settingsFile = pkgs.writeText "imp-host-settings.env" (
    lib.concatStrings (
      lib.mapAttrsToList (key: value: "${key}=${toString value}\n") (cfg.settings // moduleSettings)
    )
  );

  writeEnv = pkgs.writeShellScript "imp-host-env" ''
    export PATH=${
      lib.makeBinPath [
        pkgs.coreutils
        pkgs.gawk
        pkgs.gnused
        pkgs.gnugrep
      ]
    }
    export IMP_SETTINGS=${settingsFile}
    export IMP_STORAGE=${cfg.storage}
    export IMP_RAM_BUDGET=${lib.optionalString (cfg.ramBudgetMiB != null) (toString cfg.ramBudgetMiB)}
    export IMP_ARC_MAX=${lib.optionalString (cfg.zfs.arcMaxMiB != null) (toString cfg.zfs.arcMaxMiB)}
    export IMP_SECRETS=${lib.optionalString (cfg.environmentFile != null) cfg.environmentFile}
    export IMP_BACKUP_STAGED=${
      lib.optionalString (cfg.backupPasswordFile != null) (stagedPath "backup-password")
    }
    export IMP_BACKUP_IN_CONTAINER=${containerPath "backup-password"}
    exec ${pkgs.bash}/bin/bash ${./imp-host-env.sh} ${../bootstrap.sh}
  '';

  # The image the unit runs. With imageArchive, it is loaded whenever the
  # archive differs from the one loaded last: a store path names its
  # content, so a new archive is a new path. Without, it is pulled when
  # missing.
  ensureImage = pkgs.writeShellScript "imp-host-image" ''
    set -euo pipefail
    ref=${lib.escapeShellArg cfg.image}
    ${
      if cfg.imageArchive != null then
        ''
          stamp=${stateDir}/image-archive
          if ${docker} image inspect "$ref" >/dev/null 2>&1 \
            && [ "$(cat "$stamp" 2>/dev/null)" = ${cfg.imageArchive} ]; then
            exit 0
          fi
          echo "imp-host: loading $ref from ${cfg.imageArchive}"
          ${docker} load -q -i ${cfg.imageArchive} >/dev/null
          ${docker} image inspect "$ref" >/dev/null 2>&1 \
            || { echo "imp-host: ${cfg.imageArchive} does not hold $ref" >&2; exit 1; }
          echo ${cfg.imageArchive} >"$stamp"
        ''
      else
        ''
          ${docker} image inspect "$ref" >/dev/null 2>&1 || ${docker} pull -q "$ref"
        ''
    }
  '';

  # The network imp-host runs on with IPv6, made as bootstrap.sh makes it,
  # and made again when it differs (the options say what it is) and nothing
  # else is on it. Without IPv6, one an earlier generation made goes.
  ensureNetwork = pkgs.writeShellScript "imp-host-network" ''
    set -euo pipefail
    export PATH=${
      lib.makeBinPath [
        config.virtualisation.docker.package
        pkgs.coreutils
        pkgs.gawk
        pkgs.gnugrep
      ]
    }
    source ${../bootstrap.sh}
    ${
      if ipv6 then
        ''
          ipv6_subnet=$(subnet6 ${lib.escapeShellArg cfg.ipv6.subnet}) \
            || { echo "imp-host: services.imp.ipv6.subnet is ${cfg.ipv6.subnet}; want an IPv6 /64" >&2; exit 1; }
          if inspect=$(docker network inspect -f "$NETWORK_FORMAT" "$HOST_NETWORK" 2>/dev/null); then
            drift=$(network_drift "$ipv6_subnet" "$inspect")
            [ -n "$drift" ] || exit 0
            others=$(network_others)
            if [ -n "$others" ]; then
              echo "imp-host: the $HOST_NETWORK network differs ($drift), and $others use it; move them off it" >&2
              exit 1
            fi
            echo "imp-host: the $HOST_NETWORK network differs ($drift); making it again"
            docker network rm "$HOST_NETWORK" >/dev/null
          fi
          create_host_network
        ''
      else
        ''
          if docker network inspect "$HOST_NETWORK" >/dev/null 2>&1 && [ -z "$(network_others)" ]; then
            docker network rm "$HOST_NETWORK" >/dev/null
          fi
        ''
    }
  '';

  # How the host keeps its IPv6 default route once Docker turns on
  # forwarding (bootstrap.sh's ensure_router_adverts): a static route needs
  # nothing, networkd keeps router adverts with IPv6AcceptRA = true, and
  # otherwise the owner says (ipv6.routerAdverts).
  staticRoute6 = config.networking.defaultGateway6 != null;
  networkdKeepsRa =
    cfg.ipv6.uplink != null
    && lib.any (
      network:
      (network.matchConfig.Name or null) == cfg.ipv6.uplink
      && lib.elem (network.networkConfig.IPv6AcceptRA or null) [
        true
        "yes"
      ]
    ) (lib.attrValues config.systemd.network.networks);
  raKept = staticRoute6 || networkdKeepsRa || cfg.ipv6.routerAdverts != null;
  # NixOS's dhcpcd solicits router adverts itself (ipv6rs) and may set
  # accept_ra back, so "kernel" needs it off on the uplink.
  dhcpcdOnUplink =
    let
      uplink = config.networking.interfaces.${cfg.ipv6.uplink} or { useDHCP = null; };
    in
    config.networking.dhcpcd.enable
    && !config.networking.useNetworkd
    && (if uplink.useDHCP != null then uplink.useDHCP else config.networking.useDHCP);
  kernelRaClear =
    cfg.ipv6.routerAdverts != "kernel"
    || cfg.ipv6.uplink == null
    || !dhcpcdOnUplink
    || config.networking.dhcpcd.IPv6rs == false;
  # check_docker_ipv6 in bootstrap.sh: Docker writes the NAT66 and forward
  # rules itself from 27.0, unless ip6tables is off.
  dockerIpv6 =
    lib.versionAtLeast config.virtualisation.docker.package.version "27.0"
    && (config.virtualisation.docker.daemon.settings.ip6tables or true) != false;

  # Forwarding from imp-host's bridge. Where networking.firewall filters it,
  # the module admits imp-host's bridge alone (br-imphost with IPv6, else
  # docker0); nothing is trusted for input. The denied ranges drop in a
  # chain of their own, from either bridge: a drop in any forward chain is
  # final, and NixOS's chain accepts ICMPv6 before any rule of ours could
  # run. Only new flows drop, so the replies of a flow from a denied range
  # (a pod that reaches a public imp) still pass.
  forwardFilter = config.networking.firewall.filterForward && config.networking.nftables.enable;
  nftSet = names: "{ ${lib.concatMapStringsSep ", " (name: ''"${name}"'') names} }";
  acceptSet = nftSet [ (if ipv6 then hostBridge else "docker0") ];
  denySet = nftSet (lib.optional ipv6 hostBridge ++ [ "docker0" ]);
  denied = lib.partition (cidr: lib.hasInfix ":" cidr) cfg.forwardDeny;
  denyRule =
    family: cidrs:
    lib.optional (cidrs != [ ])
      "iifname ${denySet} ${family} daddr { ${lib.concatStringsSep ", " cidrs} } ct direction original drop";
  denyRules = denyRule "ip" denied.wrong ++ denyRule "ip6" denied.right;

  # bootstrap.sh's ruleset for hostFirewall = "own", for the SSH ports.
  firewallRules = pkgs.runCommand "imp-firewall.nft" { } ''
    ${pkgs.bash}/bin/bash -c 'source "$1"; shift; render_firewall "$@"' render \
      ${../bootstrap.sh} ${lib.escapeShellArgs (map toString config.services.openssh.ports)} >$out
  '';
in
{
  options.services.imp = {
    enable = lib.mkEnableOption "the imp host (impd, Firecracker and tailscaled in the imp-host container)";

    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/zgeoff/imp-host:latest";
      description = "The imp-host image to run.";
    };

    imageArchive = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "A docker save archive that holds `image`, used instead of a pull. It is loaded at the first start, and again whenever the archive changes (a new store path).";
    };

    storage = lib.mkOption {
      type = lib.types.enum [
        "xfs"
        "zfs"
      ];
      default = "zfs";
      description = ''
        Where disks live. zfs: a dataset in an existing pool, which the
        container mounts itself. xfs: /var/lib/imp must be an XFS mount with
        reflink, declared in fileSystems.
      '';
    };

    zfs = {
      pool = lib.mkOption {
        type = lib.types.str;
        default = "tank";
        description = "The pool. The module expects it and never creates it.";
      };
      importPool = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Import the pool at boot (boot.zfs.extraPools). False when the system imports it some other way.";
      };
      root = lib.mkOption {
        type = lib.types.str;
        default = "${cfg.zfs.pool}/imp";
        defaultText = lib.literalExpression ''"''${config.services.imp.zfs.pool}/imp"'';
        description = "imp's dataset, created with mountpoint=legacy when it is missing.";
      };
      arcMaxMiB = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        example = 6400;
        description = ''
          The ZFS ARC cap, set with boot.extraModprobeConfig so it holds from
          boot. The RAM budget leaves room for it. null: keep a cap already
          set, else set 10 % of RAM within 1 to 8 GiB, as deploy/bootstrap.sh
          does, at each start of imp-host.
        '';
      };
    };

    ramBudgetMiB = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = null;
      description = ''
        IMP_RAM_BUDGET_MIB, the RAM awake imps may use. null: RAM less the
        larger of 8 GiB and 15 %, less the ARC cap, measured at each start;
        imp-host refuses to start when that is below 512 MiB.
      '';
    };

    backupPasswordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/var/lib/imp-host/secrets/backup-password";
      description = ''
        The restic repository password for backups
        (docs/architecture/backups.md), outside the Nix store. A copy is
        mounted read-only into the container at each start, and
        IMP_BACKUP_PASSWORD_FILE names it. A missing or empty file only
        warns, and backups stay off. IMP_BACKUP_REPOSITORY and the AWS_*
        keys go in environmentFile.
      '';
    };

    publicPorts = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "443:7443"
        "80:7480"
      ];
      description = ''
        docker -p specs that publish the public listeners for public imps
        (docs/guides/https.md#public-imps), as IMP_PUBLIC_PORTS does for
        deploy/imp-host.service. Set IMP_PUBLIC_IP in settings too, and open
        the ports in the host's firewall.
      '';
    };

    hostFirewall = lib.mkOption {
      type = lib.types.enum [
        "own"
        "none"
      ];
      default = "none";
      description = ''
        none: networking.firewall (or another platform firewall) owns the
        host's inbound traffic, and imp adds no host rules. own: imp loads
        bootstrap.sh's nft table, which admits SSH only; it needs
        networking.firewall.enable = false.
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.oneOf [
          lib.types.str
          lib.types.int
        ]
      );
      default = { };
      example = {
        IMP_TAILSCALE_HOSTNAME = "imp";
        IMP_IDLE_TIMEOUT_S = 60;
      };
      description = ''
        More imp-host.env keys (docs/guides/configuration.md). They go into
        the Nix store: put secrets in environmentFile.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/imp-host.env";
      description = ''
        An env file of secrets (IMP_DNS_API_TOKEN, AWS_SECRET_ACCESS_KEY),
        outside the Nix store. Copied into imp-host.env at each start. It is
        docker --env-file format: KEY=value, no expansion, and quotes stay
        part of the value.
      '';
    };

    ipv6 = {
      enable = lib.mkEnableOption ''
        imps' IPv6: imp-host runs on the Docker network imp-host, with the
        /64 `ipv6.subnet` and the bridge br-imphost, behind Docker's NAT66,
        and impd's IMP_SUBNET6=auto gives imps IPv6 behind its own NAT66
        (docs/guides/nixos.md#ipv6). Docker turns on IPv6 forwarding for it,
        so the host's IPv6 default route must not depend on router adverts
        the kernel would then drop: an assertion asks for a static
        networking.defaultGateway6, networkd with IPv6AcceptRA = true on
        `ipv6.uplink`, or `ipv6.routerAdverts`. Turning it off again
        cold-boots every imp that has an IPv6 prefix'';

      subnet = lib.mkOption {
        type = lib.types.strMatching "[0-9A-Fa-f:]+/64";
        default =
          let
            seed =
              if config.networking.hostId != null then config.networking.hostId else config.networking.hostName;
            hash = builtins.hashString "sha256" "imp-host-network:${seed}";
          in
          "fd${builtins.substring 0 2 hash}:${builtins.substring 2 4 hash}:${builtins.substring 6 4 hash}::/64";
        defaultText = lib.literalMD "a unique local /64 from a hash of `networking.hostId` (else `networking.hostName`)";
        description = "The IPv6 /64 of the imp-host network. Docker's NAT66 hides it; it only has to differ from the host's other networks.";
      };

      uplink = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "eth0";
        description = "The interface of the host's IPv6 default route. Needed with routerAdverts = \"kernel\", and to find networkd's IPv6AcceptRA.";
      };

      routerAdverts = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.enum [
            "kernel"
            "handled"
          ]
        );
        default = null;
        description = ''
          Who keeps the host's router adverts once forwarding is on, when
          neither a static networking.defaultGateway6 nor networkd's
          IPv6AcceptRA = true on `uplink` does. kernel: the kernel takes
          them, and the module sets accept_ra = 2 on `uplink`; dhcpcd must
          not solicit them there (networking.dhcpcd.IPv6rs = false). handled:
          a client such as dhcpcd (the NixOS default) or NetworkManager takes
          them, and its config keeps them with forwarding on; check
          `ip -6 route show default` half an hour after imp-host starts.
        '';
      };
    };

    forwardDeny = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "10.42.0.0/16"
        "10.43.0.0/16"
      ];
      description = ''
        IPv4 and IPv6 ranges that traffic from imp-host's bridges (docker0,
        and br-imphost with IPv6) may not reach through the host, such as a
        k3s cluster's pod and service ranges. They drop in the nftables
        table imp-forward, ahead of networking.firewall's forward chain, so
        they need networking.nftables.enable.
      '';
    };

    dnsApiTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/imp-dns-api-token";
      description = ''
        The DNS provider's API token (docs/guides/https.md), outside the Nix
        store, instead of IMP_DNS_API_TOKEN in environmentFile; set one, not
        both. It is copied to /run/imp-host/dns before each start, when the
        file changes, and every 5 minutes, and impd reads the copy at each
        DNS call, so a new token works without a restart. A missing or
        empty file keeps the copy made before; with none, impd starts and
        certificates and DNS records wait for the token.
      '';
    };

    tailscaleAuthKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/imp-tailscale-authkey";
      description = ''
        A tagged auth key for the host container's node, outside the Nix
        store, such as /var/lib/imp-host/secrets/tailscale-authkey (root,
        0400). A copy is mounted read-only into the container at each start,
        and tailscale reads it only when the node has to join: when the pool
        holds no node state, or the saved node needs a login. A missing file
        only warns; the node then comes back from its saved state.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.system == "x86_64-linux";
        message = "services.imp: the imp-host image is x86_64 only";
      }
      {
        assertion = overridden == [ ];
        message = "services.imp.settings sets ${lib.concatStringsSep ", " overridden}; use the module's options (image, storage, zfs.root, hostFirewall, tailscaleAuthKeyFile, backupPasswordFile, dnsApiTokenFile, publicPorts) instead";
      }
      {
        assertion = !zfs || config.networking.hostId != null;
        message = "services.imp: ZFS needs networking.hostId, and a reinstall must keep the same one, or the pool will not import";
      }
      {
        assertion = zfs || (config.fileSystems ? "/var/lib/imp");
        message = "services.imp: with storage = \"xfs\", declare /var/lib/imp (XFS with reflink) in fileSystems";
      }
      {
        assertion = !(ownFirewall && config.networking.firewall.enable);
        message = "services.imp: hostFirewall = \"own\" needs networking.firewall.enable = false; two firewalls each drop what the other admits";
      }
      {
        assertion = !(config.networking.nftables.enable && config.networking.nftables.flushRuleset);
        message = "services.imp: networking.nftables.flushRuleset would flush Docker's rules on every reload; leave it false";
      }
      {
        assertion = !ipv6 || raKept;
        message = "services.imp.ipv6: Docker turns on IPv6 forwarding, and with it on, router adverts that set the host's IPv6 default route are dropped unless something keeps them. Set one of: a static networking.defaultGateway6; services.imp.ipv6.uplink with a systemd.network.networks entry for it that sets networkConfig.IPv6AcceptRA = true; services.imp.ipv6.routerAdverts = \"kernel\" (with ipv6.uplink: accept_ra = 2); or services.imp.ipv6.routerAdverts = \"handled\" when your DHCP client keeps them";
      }
      {
        assertion = cfg.ipv6.routerAdverts != "kernel" || cfg.ipv6.uplink != null;
        message = "services.imp.ipv6.routerAdverts = \"kernel\" needs services.imp.ipv6.uplink, the interface to set accept_ra = 2 on";
      }
      {
        assertion = kernelRaClear;
        message = "services.imp.ipv6.routerAdverts = \"kernel\": dhcpcd runs on ${toString cfg.ipv6.uplink} and solicits router adverts itself, and may set accept_ra back. Set networking.dhcpcd.IPv6rs = false, or use \"handled\"";
      }
      {
        assertion = !ipv6 || dockerIpv6;
        message = "services.imp.ipv6 needs Docker 27.0 or later with ip6tables on (virtualisation.docker.daemon.settings.ip6tables not false), which writes the network's NAT66 and forward rules";
      }
      {
        assertion = cfg.forwardDeny == [ ] || config.networking.nftables.enable;
        message = "services.imp.forwardDeny needs networking.nftables.enable = true, for its table";
      }
    ];

    virtualisation.docker.enable = true;
    # nft, to inspect the imp table
    environment.systemPackages = lib.mkIf ownFirewall [ pkgs.nftables ];

    boot.kernelModules = [
      "kvm"
      "tun"
      "loop"
    ]
    ++ lib.optional zfs "zfs";
    boot.kernel.sysctl = {
      # Guests are sized past RAM by design: the governor sleeps imps to keep
      # the awake ones under the budget, so large sparse maps must not fail.
      "vm.overcommit_memory" = 1;
      # Keep guest memory in RAM; the governor measures RAM per VM.
      "vm.swappiness" = 1;
    }
    # the slash form keeps a dotted interface name (eth0.100) whole
    // lib.optionalAttrs (ipv6 && cfg.ipv6.routerAdverts == "kernel") {
      "net/ipv6/conf/${cfg.ipv6.uplink}/accept_ra" = 2;
    };

    boot.supportedFilesystems.zfs = lib.mkIf zfs true;
    boot.zfs.extraPools = lib.mkIf (zfs && cfg.zfs.importPool) [ cfg.zfs.pool ];
    # Virtio disks have no serial, so /dev/disk/by-id (the default) has no
    # link to them and the import finds the pool MISSING; ZFS partitions a
    # whole disk, so by-partuuid has one.
    boot.zfs.devNodes = lib.mkIf (zfs && cfg.zfs.importPool) (lib.mkDefault "/dev/disk/by-partuuid");
    boot.extraModprobeConfig = lib.mkIf (zfs && cfg.zfs.arcMaxMiB != null) ''
      options zfs zfs_arc_max=${toString (cfg.zfs.arcMaxMiB * 1024 * 1024)}
    '';

    networking.firewall.extraForwardRules = lib.mkIf forwardFilter ''iifname ${acceptSet} accept comment "imp: imp-host's egress"'';
    networking.nftables.tables.imp-forward = lib.mkIf (cfg.forwardDeny != [ ]) {
      family = "inet";
      content = ''
        # services.imp.forwardDeny, before networking.firewall's chain
        chain forward {
          type filter hook forward priority filter - 1; policy accept;
          ${lib.concatStringsSep "\n  " denyRules}
        }
      '';
    };

    systemd.tmpfiles.rules = [
      "d /etc/imp 0755 root root -"
      "d /var/lib/imp 0755 root root -"
      "d ${stateDir} 0700 root root -"
    ];

    # imp's dataset, with mountpoint=legacy: the host never mounts it. Made
    # only when missing; the pool is the operator's.
    systemd.services.imp-zfs-dataset = lib.mkIf zfs {
      description = "imp's ZFS dataset";
      wants = [ "zfs-import.target" ];
      after = [ "zfs-import.target" ];
      path = [ config.boot.zfs.package ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        root=${lib.escapeShellArg cfg.zfs.root}
        if ! zfs list -H -o name "$root" >/dev/null 2>&1; then
          zfs create -o mountpoint=legacy "$root"
        fi
        [ "$(zfs get -H -o value mountpoint "$root")" = legacy ] \
          || { echo "imp-zfs-dataset: $root has mountpoint $(zfs get -H -o value mountpoint "$root"), not legacy" >&2; exit 1; }
      '';
    };

    # deploy/bootstrap.sh's imp-firewall.service, for hostFirewall = "own".
    systemd.services.imp-firewall = lib.mkIf ownFirewall {
      description = "imp host firewall (inbound SSH only)";
      unitConfig.DefaultDependencies = false;
      wants = [ "network-pre.target" ];
      before = [
        "network-pre.target"
        "shutdown.target"
      ];
      conflicts = [ "shutdown.target" ];
      wantedBy = [ "sysinit.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = "${pkgs.nftables}/bin/nft -f ${firewallRules}";
        ExecReload = "${pkgs.nftables}/bin/nft -f ${firewallRules}";
        ExecStop = "${pkgs.nftables}/bin/nft delete table inet imp_host";
      };
    };

    # The image both containers run, loaded or pulled before either starts.
    # A oneshot that stays inactive, so each start of either runs it again.
    systemd.services.imp-host-image = {
      description = "imp host image (load or pull)";
      requires = [ "docker.service" ];
      after = [ "docker.service" ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = ensureImage;
        TimeoutStartSec = "15min";
      };
    };

    systemd.services.imp-docker-proxy = {
      description = "imp Docker socket proxy (the Docker API calls impd makes)";
      documentation = [ "https://github.com/zgeoff/imp/blob/main/docs/architecture/host-contract.md" ];
      wantedBy = [ "multi-user.target" ];
      requires = [
        "docker.service"
        "imp-host-image.service"
      ];
      after = [
        "docker.service"
        "imp-host-image.service"
      ];
      # IMP_HOST_IMAGE, whose repository a pull may not move; -e NAME passes
      # these two, and nothing else, to the container
      environment = {
        IMP_HOST_IMAGE = cfg.image;
      }
      // lib.optionalAttrs (cfg.settings ? IMP_BUILD_CONTEXT_MAX_MIB) {
        IMP_BUILD_CONTEXT_MAX_MIB = toString cfg.settings.IMP_BUILD_CONTEXT_MAX_MIB;
      };
      serviceConfig = {
        Type = "exec";
        ExecStartPre = [
          "-${docker} rm -f imp-docker-proxy"
          proxyDirs
        ];
        ExecStart = runProxy;
        # up once the socket is there, so impd's first docker call finds it
        ExecStartPost = waitProxy;
        ExecStop = "${docker} stop -t 10 imp-docker-proxy";
        Restart = "always";
        RestartSec = 2;
      };
    };

    # The token again whenever its file changes, and every 5 minutes for
    # what PathChanged misses, such as a symlink pointed somewhere new.
    systemd.services.imp-host-dns-token = lib.mkIf dnsToken {
      description = "imp host DNS API token (stage a new one for impd)";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = stageDnsToken;
      };
    };
    systemd.paths.imp-host-dns-token = lib.mkIf dnsToken {
      description = "imp host DNS API token file";
      wantedBy = [ "multi-user.target" ];
      pathConfig.PathChanged = cfg.dnsApiTokenFile;
    };
    systemd.timers.imp-host-dns-token = lib.mkIf dnsToken {
      description = "imp host DNS API token, every 5 minutes";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5min";
        OnUnitActiveSec = "5min";
      };
    };

    systemd.services.imp-host = {
      description = "imp host (impd, Firecracker, tailscaled)";
      documentation = [ "https://github.com/zgeoff/imp/blob/main/docs/guides/nixos.md" ];
      wantedBy = [ "multi-user.target" ];
      requires = [
        "docker.service"
        "imp-host-image.service"
      ]
      ++ lib.optional zfs "imp-zfs-dataset.service";
      # impd reaches Docker through the proxy. Wants, not BindsTo: a proxy
      # that stops fails image work only, and the imps keep running.
      wants = [
        "network-online.target"
        "imp-docker-proxy.service"
      ];
      after = [
        "docker.service"
        "network-online.target"
        "imp-host-image.service"
        "imp-docker-proxy.service"
      ]
      ++ lib.optional zfs "imp-zfs-dataset.service";
      unitConfig = {
        RequiresMountsFor = "/var/lib/imp";
        # A start that keeps failing (a refused budget, a missing pool) stops
        # after five tries instead of looping.
        StartLimitIntervalSec = 300;
        StartLimitBurst = 5;
      };
      serviceConfig = {
        Type = "exec";
        ExecStartPre =
          lib.optional (secrets != [ ]) stageSecrets
          ++ lib.optional dnsToken stageDnsToken
          ++ [
            writeEnv
            # A container left over from a crash would hold the name.
            "-${docker} rm -f imp-host"
            ensureNetwork
          ];
        ExecStart = "${docker} run ${lib.escapeShellArgs runArgs}";
        # SIGTERM makes impd sleep every awake imp; it gets up to 120 s.
        ExecStop = "${docker} stop -t 120 imp-host";
        TimeoutStartSec = "15min";
        TimeoutStopSec = 150;
        Restart = "on-failure";
        RestartSec = 5;
      };
    };
  };
}
