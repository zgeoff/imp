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
  fakeBackupPassword = "fake-backup-password-for-the-vm-test";
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

  # Stands in for the tailscale CLI. The saved state says "valid" (Running),
  # "starting" (Starting) or anything else (NeedsLogin); `up` reads the key file, logs its
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
      # a single-use key that joined once already
      if [ "$(cat "$key_file")" = used-key ]; then
        echo "backend error: invalid key: unable to validate API key" >&2
        exit 1
      fi
      echo "up $*" >>"$dir/fake-up.log"
      echo valid >"$dir/tailscaled.state"
      echo "$name" >"$dir/fake-hostname"
      exit 0
    fi
    case $(cat "$dir/tailscaled.state" 2>/dev/null) in
      valid) state=Running ;;
      starting) state=Starting ;; # no network yet
      *) state=NeedsLogin ;;
    esac
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
      backupPasswordFile = "/etc/imp-test/backup-password";
      environmentFile = "/etc/imp-test/imp-host.env";
      settings.IMP_TAILSCALE_HOSTNAME = "imp-vm";
    };
    # A store file would do in a test, but the module takes paths outside it.
    environment.etc."imp-test/authkey".text = fakeKey;
    environment.etc."imp-test/backup-password".text = fakeBackupPassword;
    environment.etc."imp-test/imp-host.env".text =
      "IMP_BACKUP_REPOSITORY=s3:https://example.invalid/imp\n";
    # 3 GiB is below what the formula needs, so imp-host refuses to start
    # until ramBudgetMiB is set; the test switches to this.
    specialisation.budget.configuration.services.imp.ramBudgetMiB = 1024;
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

    def start_imp_host(want_rc="0"):
        host.succeed("rm -f ${stateDir}/up.rc")
        host.succeed("systemctl reset-failed imp-host || true")
        host.succeed("systemctl restart imp-host")
        host.wait_until_succeeds("test -s ${stateDir}/up.rc", timeout=120)
        rc = host.succeed("cat ${stateDir}/up.rc").strip()
        out = host.succeed("cat ${stateDir}/up.out")
        assert rc == want_rc, f"tailscale-up exited {rc}, not {want_rc}: {out}"
        return out

    def restarts():
        return int(host.succeed("systemctl show -p NRestarts --value imp-host"))

    def loads():
        return int(host.succeed("journalctl -u imp-host --no-pager | grep -c 'imp-host: loading' || true"))

    def ups():
        return host.succeed("cat ${stateDir}/fake-up.log 2>/dev/null || true").strip().splitlines()

    with subtest("without the pool, imp-host does not start"):
        host.fail("systemctl is-active imp-host")

    with subtest("a budget below the floor is refused, and the refusal does not loop"):
        host.succeed("zpool create -O mountpoint=none tank /dev/vdb")
        host.fail("systemctl start imp-host")
        host.wait_until_succeeds("journalctl -u imp-host --no-pager | grep -q 'below the 512 MiB floor: RAM'", timeout=60)
        host.succeed("journalctl -u imp-host --no-pager | grep -q 'Set services.imp.ramBudgetMiB'")
        host.wait_until_succeeds("systemctl show -p Result --value imp-host | grep -qx start-limit-hit", timeout=120)
        host.succeed("test ! -e /etc/imp/imp-host.env")

    with subtest("with ramBudgetMiB, imp-host starts and joins with the key file"):
        host.succeed("/run/booted-system/specialisation/budget/bin/switch-to-configuration test")
        start_imp_host()
        host.succeed("zfs get -H -o value mountpoint tank/imp | grep -qx legacy")
        joins = ups()
        assert len(joins) == 1, joins
        assert "--auth-key=file:/run/imp/tailscale-authkey" in joins[0], joins
        assert "--hostname=imp-vm" in joins[0], joins

    with subtest("a restart from good saved state uses no key, and loads no image"):
        out = start_imp_host()
        assert len(ups()) == 1, ups()
        assert loads() == 1, loads()

    with subtest("an archive that differs from the one loaded is loaded again"):
        host.succeed("echo /nix/store/another-archive > /var/lib/imp-host/image-archive")
        start_imp_host()
        assert loads() == 2, loads()

    with subtest("saved state that needs a login joins again with the key"):
        host.succeed("echo stale > ${stateDir}/tailscaled.state")
        out = start_imp_host()
        assert "joining again with the key" in out, out
        assert len(ups()) == 2, ups()

    with subtest("a missing key file warns, and the node starts from its saved state"):
        host.succeed("rm /etc/imp-test/authkey")
        out = start_imp_host()
        assert len(ups()) == 2, ups()
        host.succeed("journalctl -u imp-host --no-pager | grep -q 'authkey is missing or empty; the node starts from its saved state'")

    with subtest("stale state and no key: a clear failure, imp-host keeps running"):
        before = restarts()
        host.succeed("echo stale > ${stateDir}/tailscaled.state")
        out = start_imp_host(want_rc="1")
        assert "give an auth key to join again" in out, out
        host.succeed("systemctl is-active imp-host")
        assert restarts() == before, (before, restarts())

    with subtest("a single-use key used already: a clear failure, no loop"):
        host.succeed("install -m 0400 /dev/stdin /etc/imp-test/authkey <<< used-key")
        out = start_imp_host(want_rc="1")
        assert "single-use key that was used already" in out, out
        assert len(ups()) == 2, ups()
        host.succeed("systemctl is-active imp-host")
        host.succeed("sleep 10; systemctl is-active imp-host")
        assert restarts() == before, (before, restarts())

    with subtest("a new key joins again"):
        host.succeed("install -m 0400 /dev/stdin /etc/imp-test/authkey <<< ${fakeKey}")
        start_imp_host()
        assert len(ups()) == 3, ups()

    with subtest("saved state still Starting (no network): counts as good, waits in the background"):
        host.succeed("echo starting > ${stateDir}/tailscaled.state")
        out = start_imp_host()
        assert "going on, and waiting for it in the background" in out, out
        assert len(ups()) == 3, ups()
        # the control plane answers: the node was deleted, so it joins with the key
        host.succeed("echo stale > ${stateDir}/tailscaled.state")
        host.wait_until_succeeds("test $(wc -l < ${stateDir}/fake-up.log) = 4", timeout=60)
        host.succeed("grep -q 'the saved node is NeedsLogin; joining again with the key' ${stateDir}/up.out")

    with subtest("saved state still Starting and no key (a reboot with no network): impd comes up"):
        host.succeed("rm /etc/imp-test/authkey")
        host.succeed("echo starting > ${stateDir}/tailscaled.state")
        out = start_imp_host()
        assert "going on, and waiting for it in the background" in out, out
        assert len(ups()) == 4, ups()
        host.succeed("systemctl is-active imp-host")
        # tailscaled connects by itself: no login, no key
        host.succeed("echo valid > ${stateDir}/tailscaled.state")
        host.wait_until_succeeds("grep -q 'the saved node is Running' ${stateDir}/up.out", timeout=60)
        assert len(ups()) == 4, ups()

    with subtest("the key is never in the env, argv, the log or the store's env file"):
        host.fail("grep -q TAILSCALE_AUTHKEY /etc/imp/imp-host.env")
        host.fail("docker inspect -f '{{.Config.Env}}' imp-host | grep -qF ${fakeKey}")
        host.fail("grep -qF ${fakeKey} ${stateDir}/fake-up.log ${stateDir}/up.out")
        host.fail("journalctl -b --no-pager | grep -qF ${fakeKey}")

    with subtest("the backup password: a file in the container, never a value"):
        host.succeed("grep -qx IMP_BACKUP_PASSWORD_FILE=/run/imp/backup-password /etc/imp/imp-host.env")
        host.succeed("grep -qx IMP_BACKUP_REPOSITORY=s3:https://example.invalid/imp /etc/imp/imp-host.env")
        host.fail("grep -qF ${fakeBackupPassword} /etc/imp/imp-host.env")
        host.fail("docker inspect imp-host | grep -qF ${fakeBackupPassword}")
        host.fail("journalctl -b --no-pager | grep -qF ${fakeBackupPassword}")
        assert host.succeed("docker exec imp-host cat /run/imp/backup-password").strip() == "${fakeBackupPassword}"
        host.fail("docker exec imp-host sh -c 'echo x > /run/imp/backup-password'")

    with subtest("no backup password: a warning, and backups stay off"):
        host.succeed("rm /etc/imp-test/backup-password")
        start_imp_host()
        host.succeed("journalctl -u imp-host --no-pager | grep -q 'backup-password is missing or empty; backups stay off'")
        host.succeed("grep -qx IMP_BACKUP_REPOSITORY= /etc/imp/imp-host.env")
        host.fail("grep -q IMP_BACKUP_PASSWORD_FILE /etc/imp/imp-host.env")

    with subtest("the env file"):
        assert host.succeed("stat -c %a /etc/imp/imp-host.env").strip() == "600"
        for line in ["IMP_HOST_FIREWALL=none", "IMP_STORAGE_BACKEND=zfs", "IMP_ZFS_ROOT=tank/imp",
                     "IMP_TAILSCALE_HOSTNAME=imp-vm", "IMP_HOST_IMAGE=imp-host-stub:test"]:
            host.succeed(f"grep -qx {line} /etc/imp/imp-host.env")
        # the formula refused this host (above); ramBudgetMiB is what runs
        host.succeed("grep -qx IMP_RAM_BUDGET_MIB=1024 /etc/imp/imp-host.env")

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
