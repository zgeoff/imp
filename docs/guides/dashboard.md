# Dashboard

impd serves a web dashboard at `/ui/` on its API port: `http://localhost:7070/ui/` on the host, or
`http://<tailnet-host>:7070/ui/` on your tailnet. `/` redirects there.

## What it shows

- **Imps**: every imp with its state, RAM, last activity and URL, and notes: why it failed, why its
  next wake boots cold, which parts it runs outdated, and a hold that keeps it awake. Each row has
  the buttons that fit its state (sleep, wake, start, stop, restart), the console and destroy.
- **One imp**: its details, both URLs, the checkpoints (take, restore, fork, delete) and a fork of
  its disk as it is now.
- **Console**: a login shell in the browser (xterm.js), as `imp console` opens. It wakes a sleeping
  imp. Closing the tab ends the shell.
- **Images**: add one from an image ref, or delete one.
- **RAM**: the budget, what awake imps own, what the governor holds back for boots and wakes, and
  the RAM each awake imp owns and has resident.

Views ask impd again every 2 s (lists that change only by hand: every 10 s). The governor's
decisions are not in the API yet; they come with the event stream
([#38](https://github.com/zgeoff/imp/issues/38)).

## Log in

The login page asks for the API token once: `/var/lib/imp/token` on the host, or
`scripts/dev.sh token` for a dev instance. impd answers with a session cookie and the browser never
keeps the token. The session lasts 30 days. Log out clears it in that browser; a new token ends
every session. [The daemon](../architecture/daemon.md#dashboard) has the details and the security
model.

## Build and run it

The release image has the dashboard built in. From the repo:

```sh
bun run build:dashboard                    # packages/dashboard/dist, which the dev instance serves
cd packages/dashboard && bun run dev       # Vite on :5173, /rpc, /auth and /exec go to the dev impd
```

The Vite dev server forwards to impd at `7070 + IMP_DEV_PORT_OFFSET` and keeps the Host header, so
the login works on `http://localhost:5173/ui/` too.

## Tests

```sh
bun run test:dashboard                     # component tests against a fake impd, under happy-dom
cd packages/dashboard && bunx playwright test   # end to end, against a running dev instance
```

The component tests render the whole app over a fake impd that implements the API contract, so a
query goes through the SDK and oRPC's wire format. They run in their own `bun test`: the DOM they
register must not reach the daemon's tests, and the root `bun test` skips the package.

The end-to-end test logs in, creates an imp, runs a command in its console, sleeps and destroys it,
then logs out. It reads `IMP_URL` (default: the dev instance at `7070 + IMP_DEV_PORT_OFFSET`) and
`IMP_TOKEN`, and needs `bun run build:dashboard` first:

```sh
export IMP_DEV_NAME=imp-dev-dash IMP_DEV_PORT_OFFSET=3600
scripts/dev.sh up && bun run build:dashboard
IMP_TOKEN=$(scripts/dev.sh token) bun run --cwd packages/dashboard e2e
scripts/dev.sh down
```

## Not yet

- HTTPS on `https://imp.<tailnet>.ts.net` through `tailscale serve`. The session and its origin
  check already work behind such a front.
- Tailnet identity instead of the token ([#29](https://github.com/zgeoff/imp/issues/29)).
- Detachable sessions in the console ([#13](https://github.com/zgeoff/imp/issues/13)). The console
  view takes a terminal source, so attaching to a session is a second source next to the login
  shell.
