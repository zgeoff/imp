# Boots a NixOS VM with nixosModules.imp on a ZFS pool and a stand-in image,
# as scripts/test-bootstrap.sh --stub does for bootstrap.sh: the unit runs
# the stub with the release image's flags, and the stub's tailscale reports
# Running, so the key is used once and dropped. No imp boots; that needs the
# release image (docs/guides/nixos.md#test-it). Needs KVM, with nesting for
# the VM's /dev/kvm.
{ pkgs, self }:

let
  fakeKey = "fake-authkey-for-the-vm-test";

  fakeTailscale = pkgs.writeShellScriptBin "tailscale" ''
    echo '{"BackendState":"Running"}'
  '';

  stub = pkgs.dockerTools.buildImage {
    name = "imp-host-stub";
    tag = "test";
    copyToRoot = pkgs.buildEnv {
      name = "imp-host-stub-root";
      paths = [
        pkgs.busybox
        fakeTailscale
      ];
      pathsToLink = [ "/bin" ];
    };
    config = {
      Cmd = [
        "/bin/sh"
        "-c"
        "mkdir -p /var/lib/imp/tailscale && echo stub >/var/lib/imp/tailscale/tailscaled.state && exec sleep infinity"
      ];
      Labels."imp.tailscale-keyless" = "1";
    };
  };
in
pkgs.testers.runNixOSTest {
  name = "imp-nixos-module";

  nodes.host = {
    imports = [ self.nixosModules.imp ];
    virtualisation = {
      memorySize = 3072;
      emptyDiskImages = [ 4096 ];
    };
    networking.hostId = "8425e349";
    # As the cloud host has it: the platform owns the firewall, with nftables.
    networking.nftables.enable = true;
    networking.firewall.allowedUDPPorts = [ 41641 ];
    services.imp = {
      enable = true;
      image = "imp-host-stub:test";
      imageArchive = stub;
      tailscale.authKeyFile = "/etc/imp-test/authkey";
      settings.IMP_TAILSCALE_HOSTNAME = "imp-vm";
    };
    # A store file would do in a test, but the module takes a path outside it.
    environment.etc."imp-test/authkey".text = fakeKey;
  };

  testScript = ''
    import json

    host.start()
    host.wait_for_unit("multi-user.target")

    with subtest("without the pool, imp-host does not start"):
        host.fail("systemctl is-active imp-host")

    with subtest("the pool, then imp-host"):
        host.succeed("zpool create -O mountpoint=none tank /dev/vdb")
        host.succeed("systemctl start imp-host")
        host.wait_until_succeeds("docker inspect -f '{{.State.Running}}' imp-host | grep -qx true", timeout=120)
        host.succeed("zfs get -H -o value mountpoint tank/imp | grep -qx legacy")

    with subtest("the key is used once, then dropped"):
        host.wait_until_succeeds("test -e /var/lib/imp-host/tailscale-joined", timeout=120)
        host.wait_until_succeeds("grep -qx 'TAILSCALE_AUTHKEY=' /etc/imp/imp-host.env", timeout=60)
        host.wait_until_succeeds("docker inspect -f '{{.State.Running}}' imp-host | grep -qx true", timeout=60)
        host.fail("docker inspect -f '{{.Config.Env}}' imp-host | grep -qF ${fakeKey}")
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
        arc = max(1024, min(8192, mem // 10))
        assert budget == mem - max(8192, mem * 15 // 100) - arc, f"budget {budget}, RAM {mem} MiB"
        host.succeed(f"grep -qx {arc * 1024 * 1024} /sys/module/zfs/parameters/zfs_arc_max")

    with subtest("the kernel"):
        host.succeed("sysctl -n vm.overcommit_memory | grep -qx 1")
        host.succeed("sysctl -n vm.swappiness | grep -qx 1")
        host.succeed("test -c /dev/kvm && test -c /dev/net/tun && test -c /dev/zfs")

    with subtest("no imp rules on the host; the platform's firewall stays"):
        ruleset = json.loads(host.succeed("nft -j list ruleset"))["nftables"]
        tables = [o["table"]["name"] for o in ruleset if "table" in o]
        assert "imp_host" not in tables, tables
        inputs = [o["chain"] for o in ruleset if "chain" in o and o["chain"].get("hook") == "input"]
        assert all(c["table"] == "nixos-fw" for c in inputs), inputs
        host.succeed("nft list ruleset | grep -q 41641")
        published = host.succeed("docker port imp-host").strip().splitlines()
        assert published and all(" -> 127.0.0.1:" in p for p in published), published

    with subtest("a restart keeps the node off the key"):
        host.succeed("systemctl restart imp-host")
        host.wait_until_succeeds("docker inspect -f '{{.State.Running}}' imp-host | grep -qx true", timeout=60)
        host.succeed("grep -qx 'TAILSCALE_AUTHKEY=' /etc/imp/imp-host.env")
  '';
}
