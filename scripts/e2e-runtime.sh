#!/bin/bash
# M6-M8 end to end: sleep and wake, idle sleep, the wake proxy, holds, the RAM
# governor and restart survival, against the dev container.
#
#   scripts/e2e-runtime.sh
#
# Restarts the dev instance (scripts/dev.sh reboot) twice with its own tuning
# and leaves it running. Uses 512 MiB imps and a 2048 MiB budget: guests need
# about 3 GiB of host RAM at the peak.
# Env: IMP_DEV_NAME and IMP_DEV_PORT_OFFSET pick the dev instance (scripts/dev.sh).
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "$0")/lib.sh"

container=${IMP_DEV_NAME:-imp-dev}
offset=${IMP_DEV_PORT_OFFSET:-0}
export IMP_URL=${IMP_URL:-http://localhost:$((7070 + offset))}
proxy=http://localhost:$((7080 + offset))
idle_s=8
budget=2048
cli=(bun "$IMP_ROOT/packages/cli/src/main.ts")
a=rt-$$
governed=()

imp() { "${cli[@]}" "$@"; }

now_ms() { echo $(($(date +%s%N) / 1000000)); }

step() { echo "== $*"; }

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_eq() {
  [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"
}

# json_field NAME FIELD prints one field of `imp ls --json` for NAME
json_field() {
  imp ls --json | NAME=$1 FIELD=$2 bun -e '
    const imps = await Bun.stdin.json();
    const imp = imps.find((i) => i.name === process.env.NAME);
    console.log(imp?.[process.env.FIELD] ?? "");'
}

info_field() {
  imp info --json | FIELD=$1 bun -e 'console.log((await Bun.stdin.json())[process.env.FIELD])'
}

state_of() { json_field "$1" state; }

# wait_state NAME STATE SECONDS
wait_state() {
  local deadline=$((SECONDS + $3))
  until [ "$(state_of "$1")" = "$2" ]; do
    [ $SECONDS -lt $deadline ] || fail "$1 not $2 after $3 s (state $(state_of "$1"))"
    sleep 1
  done
}

# A value only the guest's memory holds: a tmpfs file plus the boot id and the
# pid of a background process. A cold boot loses all three.
write_proof() {
  imp exec "$1" -- sh -c 'mkdir -p /run/proof
    cat /proc/sys/kernel/random/uuid > /run/proof/value
    setsid nohup sleep 1000000 >/dev/null 2>&1 < /dev/null &
    echo $! > /run/proof/pid
    echo "$(cat /run/proof/value) $(cat /proc/sys/kernel/random/boot_id) $(cat /run/proof/pid)"'
}

read_proof() {
  imp exec "$1" -- sh -c 'kill -0 "$(cat /run/proof/pid)" &&
    echo "$(cat /run/proof/value) $(cat /proc/sys/kernel/random/boot_id) $(cat /run/proof/pid)"'
}

# an HTTP server on :8080 whose token lives only in its memory
start_server() {
  imp exec "$1" -- sh -c 'cat > /root/srv.pl' <<'PERL'
use IO::Socket::INET;
my $token = join '', map { int(rand(10)) } 1 .. 16;
my $s = IO::Socket::INET->new(LocalPort => 8080, Listen => 16, ReuseAddr => 1) or die "listen: $!";
while (my $c = $s->accept) {
  my $req = <$c> // '';
  while (my $l = <$c>) { last if $l =~ /^\r?\n$/ }
  my ($path) = $req =~ m{^\S+ (\S+)};
  my $body = "token=$token path=$path\n";
  print $c "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: " . length($body) . "\r\nConnection: close\r\n\r\n$body";
  close $c;
}
PERL
  imp exec "$1" -- sh -c 'setsid nohup perl /root/srv.pl >/root/srv.log 2>&1 </dev/null & sleep 0.3'
}

reboot_instance() {
  local t0
  t0=$(now_ms)
  "$IMP_ROOT/scripts/dev.sh" reboot | grep -v '^dev.sh' || true
  IMP_TOKEN=$("$IMP_ROOT/scripts/dev.sh" token)
  export IMP_TOKEN
  echo "reboot (sleep all, container restart, impd ready): $(($(now_ms) - t0)) ms"
}

cleanup() {
  local rc=$?
  for name in "$a" "${governed[@]}" "$a-big"; do
    imp rm "$name" >/dev/null 2>&1 || true
  done
  if [ $rc -ne 0 ]; then
    echo "== impd log tail"
    docker logs --tail 40 "$container" 2>&1 || true
  fi
}
trap cleanup EXIT

step "dev instance: idle timeout ${idle_s}s, budget ${budget} MiB"
export IMP_IDLE_TIMEOUT_S=$idle_s IMP_RAM_BUDGET_MIB=$budget
reboot_instance

step "sleep and wake by API"
imp new "$a" --memory 512 >/dev/null
imp hold "$a" 10m >/dev/null
proof=$(write_proof "$a")
start_server "$a"
token=$(curl -fsS -H "Host: $a.imp.localhost" "$proxy/" | sed 's/ path=.*//')
t0=$(now_ms)
imp sleep "$a" >/dev/null
echo "sleep (API round trip): $(($(now_ms) - t0)) ms"
expect_eq "$(state_of "$a")" sleeping "state after sleep"
t0=$(now_ms)
imp wake "$a" >/dev/null
echo "wake (API round trip): $(($(now_ms) - t0)) ms"
expect_eq "$(read_proof "$a")" "$proof" "memory after sleep and wake"
docker logs "$container" 2>&1 | grep "impd: $a: \(asleep\|woke\)" | tail -2

step "idle imp sleeps by itself"
imp hold "$a" 0 >/dev/null
t0=$(now_ms)
wait_state "$a" sleeping $((idle_s + 15))
echo "asleep $(($(now_ms) - t0)) ms after the hold ended (timeout ${idle_s}s)"

step "HTTP wakes it and the in-memory server answers"
t0=$(now_ms)
headers=$(curl -fsS -D- -o "$IMP_ROOT/.cache/e2e-body-$$" -H "Host: $a.imp.localhost" "$proxy/wake")
total=$(($(now_ms) - t0))
body=$(cat "$IMP_ROOT/.cache/e2e-body-$$")
rm -f "$IMP_ROOT/.cache/e2e-body-$$"
expect_eq "${body% path=*}" "$token" "server token after a wake by HTTP"
wake_ms=$(echo "$headers" | tr -d '\r' | sed -n 's/^x-imp-wake-ms: //Ip')
echo "proxy wake: ${wake_ms} ms in impd, ${total} ms request to response"
slot=$(json_field "$a" slot)
port_body=$(curl -fsS "http://localhost:$((20000 + offset + slot))/port")
expect_eq "${port_body% path=*}" "$token" "server token on the per-imp port"
expect_eq "$(read_proof "$a")" "$proof" "memory after a wake by HTTP"

step "a finished proxied request does not keep it awake"
wait_state "$a" sleeping $((idle_s + 15))

step "unknown imp and refused port"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: nope-$$.imp.localhost" "$proxy/")
expect_eq "$code" 404 "unknown imp"
imp exec "$a" -- pkill -x perl
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $a.imp.localhost" "$proxy/")
expect_eq "$code" 502 "nothing on port 8080"
start_server "$a"
token=$(curl -fsS -H "Host: $a.imp.localhost" "$proxy/" | sed 's/ path=.*//')

step "an open exec session keeps it awake"
imp exec "$a" -- sleep $((idle_s + 6))
expect_eq "$(state_of "$a")" running "state right after a long exec"
wait_state "$a" sleeping $((idle_s + 15))

step "hold keeps it awake"
imp hold "$a" 1m >/dev/null
sleep $((idle_s + 6))
expect_eq "$(state_of "$a")" running "state while held"
imp hold "$a" 0 >/dev/null
wait_state "$a" sleeping $((idle_s + 15))

step "governor: 512 MiB imps with 350 MiB of tmpfs each, budget ${budget} MiB"
export IMP_IDLE_TIMEOUT_S=600
reboot_instance
for i in 1 2 3 4 5 6; do
  name=$a-g$i
  governed+=("$name")
  imp new "$name" --memory 512 >/dev/null
  imp exec "$name" -- sh -c 'mkdir -p /ballast && mount -t tmpfs -o size=400m tmpfs /ballast &&
    head -c 350M /dev/zero > /ballast/fill && echo ok' >/dev/null
  echo "created $name; used $(info_field ramUsedMib) MiB, reserved $(info_field ramReservedMib) MiB"
done
sleep 7
imp ls
used=$(info_field ramUsedMib)
asleep=$(imp ls --json | bun -e 'console.log((await Bun.stdin.json()).filter((i) => i.state === "sleeping").length)')
echo "RAM used ${used} MiB of ${budget}; ${asleep} imps asleep"
[ "$used" -le "$budget" ] || fail "RAM used ${used} MiB is over the ${budget} MiB budget"
[ "$asleep" -ge 1 ] || fail "the governor slept no imp"
expect_eq "$(state_of "$a-g1")" sleeping "the least recently active imp"
t0=$(now_ms)
expect_eq "$(imp exec "$a-g1" -- sh -c 'du -m /ballast/fill | cut -f1')" 350 "ballast after a governor sleep"
echo "wake of $a-g1 (other imps slept to fit): $(($(now_ms) - t0)) ms"
sleep 7
used=$(info_field ramUsedMib)
[ "$used" -le "$budget" ] || fail "RAM used ${used} MiB is over the ${budget} MiB budget after a wake"

step "an imp that cannot fit fails with RAM_BUDGET_EXCEEDED"
for name in "${governed[@]}"; do
  [ "$(state_of "$name")" = running ] && imp hold "$name" 10m >/dev/null
done
in_use=$(($(info_field ramUsedMib) + $(info_field ramReservedMib)))
# the boot reserve is 50% of memory: twice the room left, plus margin
memory=$(((budget - in_use) * 2 + 512))
rc=0
err=$(imp new "$a-big" --memory "$memory" 2>&1) || rc=$?
echo "$err"
[ $rc -ne 0 ] || fail "a ${memory} MiB imp booted with ${in_use} MiB of ${budget} in use"
[[ $err == *RAM_BUDGET_EXCEEDED* ]] || fail "expected RAM_BUDGET_EXCEEDED"
imp rm "$a-big" >/dev/null 2>&1 || true

step "restart survival: dev.sh reboot sleeps every imp and they wake intact"
survivor=$(imp ls --json | bun -e '
  const imps = await Bun.stdin.json();
  console.log(imps.find((i) => i.state === "running" && i.name.includes("-g")).name)')
survivor_proof=$(write_proof "$survivor")
reboot_instance
for name in "$a" "${governed[@]}"; do
  expect_eq "$(state_of "$name")" sleeping "$name after a reboot"
done
t0=$(now_ms)
expect_eq "$(read_proof "$survivor")" "$survivor_proof" "memory after a reboot"
echo "first exec after a reboot (wake + exec): $(($(now_ms) - t0)) ms"
body=$(curl -fsS -H "Host: $a.imp.localhost" "$proxy/after-reboot")
expect_eq "${body% path=*}" "$token" "server token after a reboot"

step "per-imp RAM"
imp ls

echo "== PASS"
