# Boots NixOS VMs with nixosModules.imp, as scripts/test-bootstrap.sh --stub
# does for bootstrap.sh. No imp boots; that needs the release image
# (docs/guides/nixos.md#test-it). Needs KVM, with nesting for the VMs'
# /dev/kvm.
#
# host: a ZFS pool on a second disk and a stand-in image that runs the real
#   host/scripts/tailscale-up.sh against a fake tailscale. It checks the env
#   file, the kernel settings, that the host has no imp rules, and the three
#   ways the node comes up: a first join with the key file, a restart from
#   good saved state with no key used, and a join again when the saved node
#   needs a login (the control plane deleted it).
# own: hostFirewall = "own", without networking.firewall; SSH connects
#   through bootstrap.sh's table and another port does not.
{ pkgs, self }:

let
  fakeKey = "fake-authkey-for-the-vm-test";
  stateDir = "/var/lib/imp/tailscale";

  # Stands in for tailscaled: a socket, and its name in ps.
  fakeTailscaled = pkgs.writeScriptBin "tailscaled" ''
    #!${pkgs.bash}/bin/bash
    for arg in "$@"; do
      case $arg in --socket=*) sock=''${arg#--socket=} ;; esac
    done
    ${pkgs.socat}/bin/socat UNIX-LISTEN:"$sock",fork SYSTEM:true &
    wait
  '';

  # Stands in for the tailscale CLI. The saved state says "valid" (Running)
  # or anything else (NeedsLogin); `up` reads the key file, logs its
  # arguments and makes the state valid.
  fakeTailscale = pkgs.writeScriptBin "tailscale" ''
    #!${pkgs.bash}/bin/bash
    dir=${stateDir}
    up= key_file= name=
    for arg in "$@"; do
      case $arg in
        up) up=1 ;;
        --auth-key=file:*) key_file=''${arg#--auth-key=file:} ;;
        --hostname=*) name=''${arg#--hostname=} ;;
      esac
    done
    if [ -n "$up" ]; then
      [ -s "$key_file" ] || { echo "fake tailscale: no key in $key_file" >&2; exit 1; }
      echo "up $*" >>"$dir/fake-up.log"
      echo valid >"$dir/tailscaled.state"
      echo "$name" >"$dir/fake-hostname"
      exit 0
    fi
    state=NeedsLogin
    [ "$(cat "$dir/tailscaled.state" 2>/dev/null)" = valid ] && state=Running
    name=$(cat "$dir/fake-hostname" 2>/dev/null || echo none)
    printf '{"BackendState":"%s","Self":{"HostName":"%s","TailscaleIPs":["100.64.0.1"],"DNSName":"%s.example.ts.net."}}\n' \
      "$state" "$name" "$name"
  '';

  stub = pkgs.dockerTools.buildImage {
    name = "imp-host-stub";
    tag = "test";
    copyToRoot = pkgs.buildEnv {
      name = "imp-host-stub-root";
      paths = [
        pkgs.busybox
        (pkgs.lib.hiPrio pkgs.procps)
        (pkgs.lib.hiPrio pkgs.bash)
        pkgs.jq
        fakeTailscaled
        fakeTailscale
      ];
      pathsToLink = [ "/bin" ];
    };
    extraCommands = ''
      mkdir -p lib/imp
      cp ${../../../host/scripts/tailscale-up.sh} lib/imp/tailscale-up.sh
      chmod 755 lib/imp/tailscale-up.sh
    '';
    config = {
      Cmd = [
        "/bin/bash"
        "-c"
        "mkdir -p ${stateDir}; /lib/imp/tailscale-up.sh >${stateDir}/up.out 2>&1; echo $? >${stateDir}/up.rc; exec sleep infinity"
      ];
      Labels."imp.tailscale-keyless" = "1";
    };
  };

  base = {
    imports = [ self.nixosModules.imp ];
    # 6.18 LTS, which the pinned ZFS 2.4.4 builds for
    boot.kernelPackages = pkgs.linuxPackages;
    networking.hostId = "8425e349";
    environment.systemPackages = [ pkgs.netcat ];
    services.imp = {
      enable = true;
      image = "imp-host-stub:test";
      imageArchive = stub;
      zfs.arcMaxMiB = 1024;
    };
  };
in
pkgs.testers.runNixOSTest {
  name = "imp-nixos-module";

  nodes.host = {
    imports = [ base ];
    virtualisation = {
      memorySize = 3072;
      emptyDiskImages = [ 4096 ];
    };
    # As the cloud host has it: the platform owns the firewall, with nftables.
    networking.nftables.enable = true;
    networking.firewall.allowedUDPPorts = [ 41641 ];
    services.imp = {
      tailscaleAuthKeyFile = "/etc/imp-test/authkey";
      settings.IMP_TAILSCALE_HOSTNAME = "imp-vm";
    };
    # A store file would do in a test, but the module takes a path outside it.
    environment.etc."imp-test/authkey".text = fakeKey;
  };

  nodes.own = {
    imports = [ base ];
    virtualisation.memorySize = 1536;
    networking.firewall.enable = false;
    services.openssh.enable = true;
    services.imp = {
      hostFirewall = "own";
      # no pool on this node; imp-host never starts, the firewall does
      zfs.importPool = false;
    };
  };

  testScript = ''
    import json

    start_all()
    host.wait_for_unit("multi-user.target")

    def start_imp_host():
        host.succeed("rm -f ${stateDir}/up.rc")
        host.succeed("systemctl restart imp-host")
        host.wait_until_succeeds("test -s ${stateDir}/up.rc", timeout=120)
        rc = host.succeed("cat ${stateDir}/up.rc").strip()
        out = host.succeed("cat ${stateDir}/up.out")
        assert rc == "0", f"tailscale-up exited {rc}: {out}"
        return out

    def ups():
        return host.succeed("cat ${stateDir}/fake-up.log 2>/dev/null || true").strip().splitlines()

    with subtest("without the pool, imp-host does not start"):
        host.fail("systemctl is-active imp-host")

    with subtest("the pool, then imp-host, and a first join with the key file"):
        host.succeed("zpool create -O mountpoint=none tank /dev/vdb")
        start_imp_host()
        host.succeed("zfs get -H -o value mountpoint tank/imp | grep -qx legacy")
        joins = ups()
        assert len(joins) == 1, joins
        assert "--auth-key=file:/run/imp/tailscale-authkey" in joins[0], joins
        assert "--hostname=imp-vm" in joins[0], joins

    with subtest("a restart from good saved state uses no key"):
        out = start_imp_host()
        assert len(ups()) == 1, ups()

    with subtest("saved state that needs a login joins again with the key"):
        host.succeed("echo stale > ${stateDir}/tailscaled.state")
        out = start_imp_host()
        assert "joining again with the key" in out, out
        assert len(ups()) == 2, ups()

    with subtest("the key is never in the env, argv, the log or the store's env file"):
        host.fail("grep -q TAILSCALE_AUTHKEY /etc/imp/imp-host.env")
        host.fail("docker inspect -f '{{.Config.Env}}' imp-host | grep -qF ${fakeKey}")
        host.fail("grep -qF ${fakeKey} ${stateDir}/fake-up.log ${stateDir}/up.out")
        host.fail("journalctl -b --no-pager | grep -qF ${fakeKey}")

    with subtest("the env file"):
        assert host.succeed("stat -c %a /etc/imp/imp-host.env").strip() == "600"
        for line in ["IMP_HOST_FIREWALL=none", "IMP_STORAGE_BACKEND=zfs", "IMP_ZFS_ROOT=tank/imp",
                     "IMP_TAILSCALE_HOSTNAME=imp-vm", "IMP_HOST_IMAGE=imp-host-stub:test"]:
            host.succeed(f"grep -qx {line} /etc/imp/imp-host.env")
        budget = int(host.succeed("sed -n 's/^IMP_RAM_BUDGET_MIB=//p' /etc/imp/imp-host.env"))
        # 3 GiB of RAM is below the 8 GiB the host keeps, so the budget is negative;
        # what matters is that it is bootstrap.sh's formula.
        mem = int(host.succeed("awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo"))
        assert budget == mem - max(8192, mem * 15 // 100) - 1024, f"budget {budget}, RAM {mem} MiB"

    with subtest("the kernel"):
        host.succeed("sysctl -n vm.overcommit_memory | grep -qx 1")
        host.succeed("sysctl -n vm.swappiness | grep -qx 1")
        host.succeed("test -c /dev/kvm && test -c /dev/net/tun && test -c /dev/zfs")
        host.succeed("grep -qx 1073741824 /sys/module/zfs/parameters/zfs_arc_max")

    with subtest("none: no imp rules on the host; the platform's firewall stays"):
        ruleset = json.loads(host.succeed("nft -j list ruleset"))["nftables"]
        tables = [o["table"]["name"] for o in ruleset if "table" in o]
        assert "imp_host" not in tables, tables
        inputs = [o["chain"] for o in ruleset if "chain" in o and o["chain"].get("hook") == "input"]
        assert all(c["table"] == "nixos-fw" for c in inputs), inputs
        host.succeed("nft list ruleset | grep -q 41641")
        published = host.succeed("docker port imp-host").strip().splitlines()
        assert published and all(" -> 127.0.0.1:" in p for p in published), published

    with subtest("own: SSH connects through the imp table, another port does not"):
        own.wait_for_unit("imp-firewall.service")
        own.wait_for_unit("sshd.service")
        own.succeed("nft list table inet imp_host | grep -q 'policy drop'")
        own.succeed("systemd-run --unit=listen9999 nc -lk 9999")
        own.wait_for_open_port(9999)
        host.succeed("nc -z -w 5 own 22")
        host.fail("nc -z -w 5 own 9999")
  '';
}
