# shellcheck shell=bash
# The body of the zpool that createStubZpool writes, which sources this file
# after it logs the call to $STUB_CALLS. It keeps its pools as `<name> <vdev>`
# lines in the stubs directory's pools file, so list, status -P and destroy see
# what create made. The settings files beside that file, each one line:
# - zpool.create: `fails`, `held` or empty; a held create writes the path in
#   zpool.create-started, then waits for the path in zpool.create-release
#   before the pool exists, and fails without a pool after 30 s
# - zpool.destroy: `fails`, `busy` (it fails as zpool does for a held pool),
#   `ignored` (it exits 0 and the pool stays) or empty
# - zpool.queries: `fail` makes list -H and status fail once a pool exists
stubs=${STUB_CALLS%/*}
pools=$stubs/pools
touch "$pools"

read -r create <"$stubs/zpool.create" || create=
read -r destroy <"$stubs/zpool.destroy" || destroy=
read -r queries <"$stubs/zpool.queries" || queries=

# a query once a pool exists fails, when the settings say so
check_query() {
  if [ "$queries" = fail ] && [ -s "$pools" ]; then
    exit 1
  fi
}

# the last two arguments: a create's pool and vdev, a destroy's pool
for arg; do
  prev=$last
  last=$arg
done

case "$1" in
  list)
    if [ "$2" = -H ]; then
      check_query
      while read -r pool _; do printf '%s\n' "$pool"; done <"$pools"
    else
      grep -q "^$2 " "$pools"
    fi
    ;;
  create)
    if [ "$create" = fails ]; then
      echo "pool already exists" >&2
      exit 1
    elif [ "$create" = held ]; then
      read -r started <"$stubs/zpool.create-started"
      read -r release <"$stubs/zpool.create-release"
      : >"$started"
      held=0
      while [ ! -e "$release" ]; do
        [ "$held" -lt 600 ] || {
          echo "no release within 30 s" >&2
          exit 1
        }
        held=$((held + 1))
        sleep 0.05
      done
    fi
    printf '%s %s\n' "$prev" "$last" >>"$pools"
    ;;
  status)
    check_query
    want=$3
    if [ -n "$want" ] && ! grep -q "^$want " "$pools"; then
      echo "cannot open '$want': no such pool" >&2
      exit 1
    fi
    while read -r pool file; do
      if [ -z "$want" ] || [ "$pool" = "$want" ]; then
        printf '  pool: %s\n\t  %s  ONLINE  0 0 0\n' "$pool" "$file"
      fi
    done <"$pools"
    ;;
  destroy)
    if [ "$destroy" = fails ]; then
      exit 1
    elif [ "$destroy" = busy ]; then
      echo "cannot destroy '$last': pool is busy" >&2
      exit 1
    elif [ "$destroy" = ignored ]; then
      exit 0
    fi
    grep -v "^$last " "$pools" >"$pools.next" || true
    mv "$pools.next" "$pools"
    ;;
esac
