# shellcheck shell=bash
# The packages phase: the tools, the ZFS packages, and Docker CE.

ensure_packages() {
  phase packages
  local wanted=(ca-certificates curl gnupg xfsprogs nftables jq iproute2 util-linux)
  local pkg missing=()
  for pkg in "${wanted[@]}"; do
    dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    change "apt-get install ${missing[*]}" apt_install "$APT_LOG" "${missing[@]}"
  fi
  [ "$storage" != zfs ] || ensure_zfs_packages
  ensure_docker
}

# Ubuntu ships the zfs module with its kernel; Debian builds it with DKMS,
# from contrib.
ensure_zfs_packages() {
  # shellcheck source=/dev/null
  . /etc/os-release
  local wanted=(zfsutils-linux) pkg missing=()
  if [ "$ID" = debian ]; then
    put_file /etc/apt/sources.list.d/imp-contrib.sources 644 "$(debian_contrib_sources)" || true
    wanted=("linux-headers-$(uname -r)" zfs-dkms zfsutils-linux)
  fi
  for pkg in "${wanted[@]}"; do
    dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    change "apt-get install ${missing[*]}" apt_install "$APT_LOG" "${missing[@]}"
  fi
}

debian_contrib_sources() {
  cat <<'EOF'
# Written by deploy/bootstrap.sh: contrib, for zfs-dkms and zfsutils-linux.
Types: deb
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: contrib
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
}

# apt_install LOG PKG...: apt's output goes to LOG, shown only on failure.
apt_install() {
  local apt_log=$1
  shift
  if ! {
    apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@"
  } >"$apt_log" 2>&1; then
    tail -n 20 "$apt_log" >&2
    die "apt-get install $* failed; the whole log is in $apt_log"
  fi
}

# Docker CE from Docker's apt repo, as host/Dockerfile uses. A Docker that is
# already installed (docker-ce or the distro's docker.io) is kept.
ensure_docker() {
  local pkg
  for pkg in docker-ce docker.io; do
    if dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
      log "docker: $pkg is installed"
      ensure_service docker
      return
    fi
  done
  # shellcheck source=/dev/null
  . /etc/os-release
  local key=/etc/apt/keyrings/docker.asc
  if [ ! -s "$key" ]; then
    change "fetch Docker's apt key to $key" fetch_docker_key "$key" "$ID"
  fi
  # A dry run has not fetched it; an existing key is checked every run.
  [ ! -s "$key" ] || check_docker_key "$key"
  put_file /etc/apt/sources.list.d/docker.list 644 \
    "deb [arch=amd64 signed-by=$key] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" || true
  change "apt-get install docker-ce" apt_install "$APT_LOG" docker-ce docker-ce-cli containerd.io
  ensure_service docker
}

fetch_docker_key() {
  install -m 0755 -d "$(dirname "$1")" || return 1
  curl -fsSL "https://download.docker.com/linux/$2/gpg" -o "$1.new" || return 1
  check_docker_key "$1.new" && chmod 0644 "$1.new" && mv "$1.new" "$1"
}

# check_docker_key FILE: the file holds Docker's key and only that key.
check_docker_key() {
  local fingerprints
  fingerprints=$(gpg --show-keys --with-colons "$1" 2>/dev/null | awk -F: '$1 == "pub" { pub = 1 } $1 == "fpr" && pub { print $10; pub = 0 }')
  if [ "$fingerprints" != "$DOCKER_KEY_FINGERPRINT" ]; then
    rm -f "$1.new"
    die "$1 is not Docker's apt key (want $DOCKER_KEY_FINGERPRINT, got ${fingerprints:-none})"
  fi
}

# ensure_service UNIT: enabled and active.
ensure_service() {
  systemctl -q is-enabled "$1" 2>/dev/null || change "enable $1" systemctl enable -q "$1"
  systemctl -q is-active "$1" 2>/dev/null || change "start $1" systemctl start "$1"
}
