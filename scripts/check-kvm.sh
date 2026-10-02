#!/bin/bash
# Check that this machine can boot Firecracker guests: the CPU exposes
# hardware virtualization and /dev/kvm opens for read and write. The host
# container runs privileged as root, so root opening the device is enough.
#
#   scripts/check-kvm.sh
#
# CI runs it before any build, so a runner without KVM fails in seconds with
# the reason instead of deep inside the end-to-end harness.
set -euo pipefail

fail() {
  echo "check-kvm: $1" >&2
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    # The repo is public: a self-hosted runner would hand every fork's pull
    # request a privileged container with /dev/kvm. Never the deploy box.
    echo "::error title=No usable KVM::$1. The e2e job needs a runner with KVM. If GitHub-hosted runners lose it, move the job to an ephemeral, dedicated self-hosted runner and run it only on push to main, never on pull requests."
  fi
  exit 1
}

echo "check-kvm: kernel $(uname -r), $(nproc) cpus, $(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo) MiB"

grep -qwE 'vmx|svm' /proc/cpuinfo || fail "the CPU exposes no vmx or svm flag"
[ -c /dev/kvm ] || fail "/dev/kvm is missing"
ls -l /dev/kvm

# Opening the device is what Firecracker needs; the mode bits alone do not
# say whether the kvm module is usable.
if ! (exec 3<>/dev/kvm) 2>/dev/null; then
  sudo -n true 2>/dev/null || fail "/dev/kvm does not open for this user, and sudo needs a password; run as root or join the kvm group"
  sudo -n bash -c 'exec 3<>/dev/kvm' 2>/dev/null || fail "/dev/kvm does not open for read and write, even as root"
fi
echo "check-kvm: /dev/kvm is usable"
