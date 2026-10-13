# The options of services.imp, the imp host on NixOS; config.nix acts on
# them. module.nix imports both.
{ config, lib, ... }:

let
  cfg = config.services.imp;
  # The module's own release: release-please bumps package.json, and
  # release.yml pushes imp-host:X.Y.Z (the tag without its v) for it.
  version = (lib.importJSON ../../package.json).version;
in
{
  options.services.imp = {
    enable = lib.mkEnableOption "the imp host (impd, Firecracker and tailscaled in the imp-host container)";

    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/zgeoff/imp-host:${version}";
      description = "The imp-host image to run. The default is the module's own release, so a pinned `inputs.imp` pins the image too; pin a digest with `ghcr.io/zgeoff/imp-host:X.Y.Z@sha256:...`.";
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
        (docs/architecture/storage/backups.md), outside the Nix store. A copy is
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

    egressDeny = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "203.0.113.7"
        "2001:db8:1::7/128"
      ];
      description = ''
        IMP_EGRESS_DENY: IPv4 and IPv6 addresses and CIDRs no public imp
        reaches (docs/architecture/network/egress.md#public). The module writes
        this host's global addresses into IMP_HOST_ADDRESSES at each start;
        list what that misses. IMP_PUBLIC_IP is always in it.
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
}
