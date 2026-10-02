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

  # The docker run arguments, shared with deploy/imp-host.service and
  # bootstrap.sh (scripts/render-imp-host.ts writes those two from it).
  sharedArgs = lib.flatten (lib.importJSON ../imp-host.args.json).lines;
  stateDir = "/var/lib/imp-host";
  # The key file, read by tailscale inside the container and only when the
  # node has to join (host/scripts/tailscale-up.sh). The container mounts a
  # copy, empty when the operator's file is gone, so a missing key never
  # stops the start: the node comes back from its saved state.
  keyPath = "/run/imp/tailscale-authkey";
  keyCopy = "/run/imp-host/tailscale-authkey";
  keyArgs = lib.optionals (cfg.tailscaleAuthKeyFile != null) [
    "-v"
    "${keyCopy}:${keyPath}:ro"
    "-e"
    "IMP_TAILSCALE_AUTHKEY_FILE=${keyPath}"
  ];
  stageKey = pkgs.writeShellScript "imp-host-key" ''
    set -euo pipefail
    export PATH=${lib.makeBinPath [ pkgs.coreutils ]}
    src=${lib.escapeShellArg (toString cfg.tailscaleAuthKeyFile)}
    install -d -m 0700 ${dirOf keyCopy}
    if [ -s "$src" ] && [ -r "$src" ]; then
      install -m 0400 "$src" ${keyCopy}
    else
      install -m 0400 /dev/null ${keyCopy}
      echo "imp-host: $src is missing or empty; the node starts from its saved state and cannot join again without a key" >&2
    fi
  '';
  runArgs = sharedArgs ++ keyArgs ++ [ cfg.image ];

  # The module's own keys; settings may not set them (an assertion below).
  # No secret goes here: it is in the Nix store.
  moduleSettings = {
    IMP_HOST_IMAGE = cfg.image;
    IMP_STORAGE_BACKEND = cfg.storage;
    IMP_ZFS_ROOT = if zfs then cfg.zfs.root else "";
    IMP_HOST_FIREWALL = cfg.hostFirewall;
  };
  overridden = lib.attrNames (
    lib.intersectAttrs (moduleSettings // { TAILSCALE_AUTHKEY = ""; }) cfg.settings
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
        message = "services.imp.settings sets ${lib.concatStringsSep ", " overridden}; use the module's options (image, storage, zfs.root, hostFirewall, tailscaleAuthKeyFile) instead";
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
    };
    boot.supportedFilesystems.zfs = lib.mkIf zfs true;
    boot.zfs.extraPools = lib.mkIf (zfs && cfg.zfs.importPool) [ cfg.zfs.pool ];
    boot.extraModprobeConfig = lib.mkIf (zfs && cfg.zfs.arcMaxMiB != null) ''
      options zfs zfs_arc_max=${toString (cfg.zfs.arcMaxMiB * 1024 * 1024)}
    '';

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

    systemd.services.imp-host = {
      description = "imp host (impd, Firecracker, tailscaled)";
      documentation = [ "https://github.com/zgeoff/imp/blob/main/docs/guides/nixos.md" ];
      wantedBy = [ "multi-user.target" ];
      requires = [ "docker.service" ] ++ lib.optional zfs "imp-zfs-dataset.service";
      wants = [ "network-online.target" ];
      after = [
        "docker.service"
        "network-online.target"
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
        ExecStartPre = [
          writeEnv
        ]
        ++ lib.optional (cfg.tailscaleAuthKeyFile != null) stageKey
        ++ [
          ensureImage
          # A container left over from a crash would hold the name.
          "-${docker} rm -f imp-host"
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
