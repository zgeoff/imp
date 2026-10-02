# The imp host on NixOS: what deploy/bootstrap.sh does on Ubuntu and Debian,
# as a module. imp's flake exports it as nixosModules.imp. The host contract
# is in docs/architecture/host-contract.md; the guide is docs/guides/nixos.md.
#
# The platform owns the inbound firewall (networking.firewall), so the env
# file says IMP_HOST_FIREWALL=none and the module adds no host rules: impd
# needs no inbound host port, and its own nft tables live in the container's
# network namespace.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.imp;
  docker = "${config.virtualisation.docker.package}/bin/docker";
  stateDir = "/var/lib/imp-host";
  joined = "${stateDir}/tailscale-joined";
  zfs = cfg.storage == "zfs";

  # The module's keys, then the operator's. No secret goes here: it is in
  # the Nix store.
  settings = {
    IMP_HOST_IMAGE = cfg.image;
    IMP_STORAGE_BACKEND = cfg.storage;
    IMP_ZFS_ROOT = if zfs then cfg.zfs.root else "";
    IMP_HOST_FIREWALL = "none";
  }
  // cfg.settings;
  settingsFile = pkgs.writeText "imp-host-settings.env" (
    lib.concatStrings (lib.mapAttrsToList (key: value: "${key}=${toString value}\n") settings)
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
    export IMP_AUTHKEY_FILE=${
      lib.optionalString (cfg.tailscale.authKeyFile != null) cfg.tailscale.authKeyFile
    }
    export IMP_JOINED=${joined}
    exec ${pkgs.bash}/bin/bash ${./imp-host-env.sh} ${../bootstrap.sh}
  '';

  # The image the unit runs: there already, else loaded from imageArchive,
  # else pulled.
  ensureImage = pkgs.writeShellScript "imp-host-image" ''
    set -euo pipefail
    ref=${lib.escapeShellArg cfg.image}
    if ${docker} image inspect "$ref" >/dev/null 2>&1; then
      exit 0
    fi
    ${
      if cfg.imageArchive != null then
        ''
          ${docker} load -q -i ${cfg.imageArchive} >/dev/null
          ${docker} image inspect "$ref" >/dev/null 2>&1 \
            || { echo "imp-host: ${cfg.imageArchive} does not hold $ref" >&2; exit 1; }
        ''
      else
        ''${docker} pull -q "$ref"''
    }
  '';

  # Wait for the node to join, then restart imp-host without the key: the
  # node state in /var/lib/imp/tailscale keeps it on the tailnet.
  tailscaleJoin = pkgs.writeShellScript "imp-host-tailscale" ''
    set -euo pipefail
    export PATH=${
      lib.makeBinPath [
        pkgs.coreutils
        config.systemd.package
        pkgs.jq
      ]
    }
    for i in $(seq 180); do
      state=$(${docker} exec imp-host tailscale --socket=/var/run/tailscale/tailscaled.sock \
        status --json 2>/dev/null | jq -r '.BackendState // empty' || true)
      [ "$state" = Running ] && break
      if [ "$i" = 180 ]; then
        echo "imp-host-tailscale: the node is not Running after 180 s (state: ''${state:-none})" >&2
        exit 1
      fi
      sleep 1
    done
    label=$(${docker} inspect -f '{{index .Config.Labels "imp.tailscale-keyless"}}' imp-host)
    if [ "$label" != 1 ]; then
      echo "imp-host-tailscale: this image needs TAILSCALE_AUTHKEY at every start; the key stays" >&2
      exit 0
    fi
    touch ${joined}
    echo "imp-host-tailscale: the node is Running; restarting imp-host without the key"
    systemctl restart --no-block imp-host.service
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
      description = "A docker save archive that holds `image`, loaded when the image is missing, instead of a pull.";
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
        description = "The pool. The module imports it at boot; it does not create it.";
      };
      root = lib.mkOption {
        type = lib.types.str;
        default = "${cfg.zfs.pool}/imp";
        defaultText = lib.literalExpression ''"''${config.services.imp.zfs.pool}/imp"'';
        description = "imp's dataset, created with mountpoint=legacy when missing.";
      };
      arcMaxMiB = lib.mkOption {
        type = lib.types.nullOr lib.types.ints.positive;
        default = null;
        description = "The ZFS ARC cap. null: 10 % of RAM within 1 to 8 GiB, as deploy/bootstrap.sh sets it.";
      };
    };

    ramBudgetMiB = lib.mkOption {
      type = lib.types.nullOr lib.types.ints.positive;
      default = null;
      description = ''
        IMP_RAM_BUDGET_MIB, the RAM awake imps may use. null: RAM less the
        larger of 8 GiB and 15 %, less the ARC cap, measured at each start.
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
        outside the Nix store. Read at each start.
      '';
    };

    tailscale.authKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/imp-tailscale-authkey";
      description = ''
        A tagged auth key for the host container's node, outside the Nix
        store. Read only until the node joins; then the module restarts
        imp-host without it, and the key can go.
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
        assertion = !(config.networking.nftables.enable && config.networking.nftables.flushRuleset);
        message = "services.imp: networking.nftables.flushRuleset would flush Docker's rules on every reload; leave it false";
      }
      {
        assertion = zfs || (config.fileSystems ? "/var/lib/imp");
        message = "services.imp: with storage = \"xfs\", declare /var/lib/imp (XFS with reflink) in fileSystems";
      }
    ];

    virtualisation.docker.enable = true;

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
    boot.zfs.extraPools = lib.mkIf zfs [ cfg.zfs.pool ];

    systemd.tmpfiles.rules = [
      "d /etc/imp 0755 root root -"
      "d /var/lib/imp 0755 root root -"
      "d ${stateDir} 0700 root root -"
    ];

    # imp's dataset, with mountpoint=legacy: the host never mounts it.
    systemd.services.imp-zfs-dataset = lib.mkIf zfs {
      description = "imp's ZFS dataset";
      requires = [ "zfs-import-${cfg.zfs.pool}.service" ];
      after = [ "zfs-import-${cfg.zfs.pool}.service" ];
      path = [ config.boot.zfs.package ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        root=${lib.escapeShellArg cfg.zfs.root}
        if ! zfs list -H -o name "$root" >/dev/null 2>&1; then
          zfs create -p -o mountpoint=legacy "$root"
        elif [ "$(zfs get -H -o value mountpoint "$root")" != legacy ]; then
          zfs set mountpoint=legacy "$root"
        fi
      '';
    };

    # deploy/imp-host.service, in Nix; deploy/nixos.test.ts keeps the docker
    # run flags equal.
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
      unitConfig.RequiresMountsFor = "/var/lib/imp";
      serviceConfig = {
        Type = "exec";
        ExecStartPre = [
          writeEnv
          ensureImage
          # A container left over from a crash would hold the name.
          "-${docker} rm -f imp-host"
        ];
        ExecStart = lib.concatStringsSep " " [
          "${docker} run --rm --name imp-host --hostname imp-host"
          "--init --privileged --device /dev/kvm"
          "--env-file /etc/imp/imp-host.env"
          "-v /var/lib/imp:/var/lib/imp"
          "-v /var/run/docker.sock:/var/run/docker.sock"
          "-v /etc/imp:/etc/imp:ro"
          "-p 127.0.0.1:7070:7070 -p 127.0.0.1:7080:7080"
          (lib.escapeShellArg cfg.image)
        ];
        # SIGTERM makes impd sleep every awake imp; it gets up to 120 s.
        ExecStop = "${docker} stop -t 120 imp-host";
        TimeoutStartSec = "15min";
        TimeoutStopSec = 150;
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    systemd.services.imp-host-tailscale = lib.mkIf (cfg.tailscale.authKeyFile != null) {
      description = "Join imp-host to the tailnet, then drop the key";
      # Each start of imp-host pulls it in, until the node has joined.
      wantedBy = [ "imp-host.service" ];
      after = [ "imp-host.service" ];
      requires = [ "imp-host.service" ];
      unitConfig.ConditionPathExists = "!${joined}";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = tailscaleJoin;
      };
    };
  };
}
