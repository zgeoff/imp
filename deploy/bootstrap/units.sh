# shellcheck shell=bash
# The env file and the units bootstrap.sh writes itself. The deploy files
# it installs as they are follow this part, from deploy/.

# render_env EXISTING TEMPLATE BUDGET IMAGE IMAGE_SET STORAGE ZFS_ROOT
# HOST_FIREWALL IPV6 SUBNET6 [KSM]: imp-host.env with bootstrap's keys set. EXISTING (empty when there is no
# file) wins over TEMPLATE; the operator's other lines stay. IMP_HOST_IMAGE
# is set when IMAGE_SET is non-empty, and a LEGACY_IMAGE_LINE becomes the
# commented pin of IMAGE otherwise (the units run their release's image).
# IMP_RAM_BUDGET_MIB is set when it is empty or still the template's,
# IMP_STORAGE_BACKEND,
# IMP_HOST_FIREWALL, IMP_HOST_IPV6 and IMP_HOST_NETWORK (from IPV6) always,
# IMP_ZFS_ROOT and IMP_HOST_SUBNET6 when theirs is non-empty, and IMP_KSM=1
# or 0 when KSM is on or off (an existing IMP_KSM stays when it is empty).
# TAILSCALE_AUTHKEY comes from the
# environment variable BOOTSTRAP_AUTHKEY, never from argv, and is set when
# non-empty.
render_env() {
  local base=$1 template=$2 budget=$3 img=$4 img_set=$5
  [ -z "$base" ] && base=$template
  BUDGET=$budget IMG=$img IMG_SET=$img_set TEMPLATE_BUDGET=$TEMPLATE_BUDGET_MIB \
    LEGACY_IMAGE=$LEGACY_IMAGE_LINE \
    STORAGE=$6 ZFS_ROOT=$7 HOST_FIREWALL=$8 IPV6=$9 SUBNET6=${10} KSM=${11:-} \
    NETWORK=$([ "$9" != on ] || echo "--network $HOST_NETWORK") \
    awk -v q="'" "$TRIM_AWK"'
      function set(key, value) { print key "=" value; done[key] = 1 }
      /^IMP_HOST_IMAGE=/ && ENVIRON["IMG_SET"] != "" { set("IMP_HOST_IMAGE", ENVIRON["IMG"]); next }
      trim($0) == ENVIRON["LEGACY_IMAGE"] { print "# IMP_HOST_IMAGE=" ENVIRON["IMG"]; next }
      /^IMP_STORAGE_BACKEND=/ { set("IMP_STORAGE_BACKEND", ENVIRON["STORAGE"]); next }
      /^IMP_ZFS_ROOT=/ && ENVIRON["ZFS_ROOT"] != "" { set("IMP_ZFS_ROOT", ENVIRON["ZFS_ROOT"]); next }
      /^IMP_HOST_FIREWALL=/ { set("IMP_HOST_FIREWALL", ENVIRON["HOST_FIREWALL"]); next }
      /^IMP_HOST_IPV6=/ { set("IMP_HOST_IPV6", ENVIRON["IPV6"]); next }
      /^IMP_HOST_NETWORK=/ { set("IMP_HOST_NETWORK", ENVIRON["NETWORK"]); next }
      /^IMP_HOST_SUBNET6=/ && ENVIRON["SUBNET6"] != "" { set("IMP_HOST_SUBNET6", ENVIRON["SUBNET6"]); next }
      /^IMP_KSM=/ && ENVIRON["KSM"] != "" { set("IMP_KSM", ENVIRON["KSM"] == "on" ? "1" : "0"); next }
      /^TAILSCALE_AUTHKEY=/ && ENVIRON["BOOTSTRAP_AUTHKEY"] != "" {
        set("TAILSCALE_AUTHKEY", ENVIRON["BOOTSTRAP_AUTHKEY"]); next
      }
      /^IMP_RAM_BUDGET_MIB=/ {
        value = substr($0, length("IMP_RAM_BUDGET_MIB=") + 1)
        if (value == "" || value == ENVIRON["TEMPLATE_BUDGET"]) { set("IMP_RAM_BUDGET_MIB", ENVIRON["BUDGET"]); next }
        done["IMP_RAM_BUDGET_MIB"] = 1
      }
      { print }
      END {
        if (!done["IMP_HOST_IMAGE"] && ENVIRON["IMG_SET"] != "") set("IMP_HOST_IMAGE", ENVIRON["IMG"])
        if (!done["TAILSCALE_AUTHKEY"] && ENVIRON["BOOTSTRAP_AUTHKEY"] != "") set("TAILSCALE_AUTHKEY", ENVIRON["BOOTSTRAP_AUTHKEY"])
        if (!done["IMP_RAM_BUDGET_MIB"]) set("IMP_RAM_BUDGET_MIB", ENVIRON["BUDGET"])
        if (!done["IMP_STORAGE_BACKEND"]) set("IMP_STORAGE_BACKEND", ENVIRON["STORAGE"])
        if (!done["IMP_ZFS_ROOT"] && ENVIRON["ZFS_ROOT"] != "") set("IMP_ZFS_ROOT", ENVIRON["ZFS_ROOT"])
        if (!done["IMP_HOST_FIREWALL"]) set("IMP_HOST_FIREWALL", ENVIRON["HOST_FIREWALL"])
        if (!done["IMP_HOST_IPV6"]) set("IMP_HOST_IPV6", ENVIRON["IPV6"])
        if (!done["IMP_HOST_NETWORK"]) set("IMP_HOST_NETWORK", ENVIRON["NETWORK"])
        if (!done["IMP_HOST_SUBNET6"] && ENVIRON["SUBNET6"] != "") set("IMP_HOST_SUBNET6", ENVIRON["SUBNET6"])
        if (!done["IMP_KSM"] && ENVIRON["KSM"] != "") set("IMP_KSM", ENVIRON["KSM"] == "on" ? "1" : "0")
      }
    ' <<<"$base"
}

# The pool imports at boot (zfs-import-cache.service); the container needs
# it and /dev/zfs before it starts.
unit_imp_host_zfs() {
  cat <<'EOF'
# Written by deploy/bootstrap.sh: import the ZFS pool before imp starts.
[Unit]
Wants=zfs.target
After=zfs.target
EOF
}
