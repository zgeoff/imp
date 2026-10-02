# Dashboard

impd serves a web dashboard at `/ui/` on its API port: `http://localhost:7070/ui/` on the host, or
`http://<tailnet-host>:7070/ui/` on your tailnet. `/` redirects there.

## What it shows

- **Imps**: every imp with its state, RAM, CPU, disk use, last activity and URL, and notes: why it
  failed, why its next wake boots cold, which parts it runs outdated, and a hold that keeps it
  awake. Each row has the buttons that fit its state (sleep, wake, start, stop, restart), the
  console and destroy.
- **One imp**: its details with disk use, both URLs, CPU use with a form for the limit and the
  weight, the checkpoints (take, restore, fork, delete) and a fork of its disk as it is now.
- **Console**: a login shell in the browser (xterm.js), as `imp console` opens. It wakes a sleeping
  imp. Closing the tab ends the shell.
- **Images**: add one from an image ref, or delete one.
- **RAM**: the budget, what awake imps own, what the governor holds back for boots and wakes, and
  the RAM each awake imp owns and has resident.
- **Tokens**: make a scoped token, which shows its secret once, or delete one. Only for a `manage`
  token with no imp patterns ([tokens](./tokens.md)). The nav shows who the session runs as.

Views follow impd's [event stream](./events.md): a change shows as impd makes it. What moves with no
event, such as RAM in use, sessions and last activity, refreshes every 10 s. When the stream ends,
the dashboard opens it again after 2 s and refreshes every view.

## Log in

The login page asks for a token once: the root token in `/var/lib/imp/token` on the host,
`scripts/dev.sh token` for a dev instance, or a token from `imp token new`. impd answers with a
session cookie and the browser never keeps the token. The session acts with that token's scope and
lasts 30 days. Log out clears it in that browser; removing the token ends its sessions, and a new
root token ends every session. A tailnet member that an
[`IMP_TAILNET_IDENTITIES`](./tokens.md#tailnet-identity) rule matches needs no login.
[The daemon](../architecture/daemon.md#dashboard) has the details and the security model.

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
then logs out. The `dashboard` suite of the [end-to-end harness](./development.md#end-to-end-tests)
builds the dashboard, installs Playwright's pinned Chromium and runs it; it is in the `fast` set CI
runs:

```sh
scripts/test-e2e.sh --only dashboard
```

On its own, it reads `IMP_URL` (default: the dev instance at `7070 + IMP_DEV_PORT_OFFSET`) and
`IMP_TOKEN`, and needs `bun run build:dashboard` and `bun run --cwd packages/dashboard e2e:install`
first.

## Not yet

- HTTPS on `https://imp.<tailnet>.ts.net` through `tailscale serve`. The session and its origin
  check already work behind such a front.
- Detachable sessions in the console ([#13](https://github.com/zgeoff/imp/issues/13)). The console
  view takes a terminal source, so attaching to a session is a second source next to the login
  shell.
