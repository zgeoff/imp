# shellcheck shell=bash
# The phases in order.

main() {
  parse_args "$@"
  preflight
  ensure_packages
  ensure_storage
  ensure_kernel
  ensure_ksm
  ensure_firewall
  ensure_ipv6
  ensure_imp
  if dry; then
    log "$changes change(s) pending"
    [ "$mode" = check ] && [ "$changes" -gt 0 ] && exit 2
    exit 0
  fi
  ensure_tailscale
  log "$changes change(s) made"
  if [ -n "$authkey_file" ]; then
    log "delete $authkey_file now; the key is not needed again (docs/guides/install.md#the-tailscale-key)"
  fi
  [ -n "$skip_health" ] || health
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
