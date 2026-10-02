# Services and logs: `imp service`, `imp logs`

A service is a long-running process that the guest agent starts at boot and restarts when it exits,
such as a web server or a database. Each service is one JSON file in `/etc/imp/services.d` in the
imp; an image can ship them ([images](./images.md#services)), and `imp service` adds, removes and
restarts them on a running imp.

```sh
imp service add box web --cmd "node server.js" --env PORT=3000 --cwd /srv/app
imp service add box web --replace -- busybox httpd -f -vv -p 8080 -h /srv/www
imp service ls box
imp service restart box web
imp service rm box web
imp logs box web -f
imp logs box -n 20
```

`add`, `rm`, `restart` and `imp logs` wake a sleeping imp and boot a stopped one, as `imp exec`
does. `imp service ls` and `imp logs -f` only look ([following](#following-a-log)):

- `ls` on a sleeping imp prints the services as they were when it went to sleep, and stderr says so.
  The list is empty when that sleep recorded none: impd from before the services API put it to
  sleep, or the agent did not answer in time.
- `ls` on a stopped imp fails with `INVALID_STATE`.
- A follow of an imp that does not run waits for it to run.

## Adding a service

`imp service add <imp> <service>` writes `/etc/imp/services.d/<service>.json` and starts the
service. The file is on the imp's disk, so the service starts again at every boot, and a checkpoint
or a fork carries it.

| Flag        | Meaning                                                                        |
| ----------- | ------------------------------------------------------------------------------ |
| `--cmd`     | The command, run by `/bin/sh -c`. Or give the argv after `--`.                 |
| `--env`     | `KEY=VALUE`, merged over the image env. Give it once per variable.             |
| `--cwd`     | Working directory (default `/`).                                               |
| `--user`    | `name`, `uid`, `name:group` or `uid:gid` (default the image's user).           |
| `--restart` | `always` (default), `on-failure` or `never`.                                   |
| `--replace` | Replace a service with the same name: the old one stops before the new starts. |

A service name is a lowercase letter or digit, then up to 62 lowercase letters, digits or `-`
(`^[a-z0-9][a-z0-9-]{0,62}$`). The file name is the service's name: a `name` field inside a file is
ignored. A name that is taken, by a running service or by a file, fails with `CONFLICT` unless
`--replace`.

`--replace` takes the new definition whole. Nothing carries over from the old one: without `--user`,
the new service runs as the image's user, whatever the old one ran as.

### During a checkpoint

A checkpoint freezes the imp's disk and holds the imp's lock. An `add` that arrives during it waits
until the checkpoint ends, then writes the file, so the checkpoint does not hold the new service. An
`add` that reached the agent just before the freeze finishes its write after the thaw; the
checkpoint holds the disk as it was before the write. The file is synced, and its directory too, so
a crash after `add` returns keeps it.

The env goes into the file as given. `imp service ls --json` shows only the keys (`envKeys`), but
anyone who can exec in the imp can read the file, so keep long-lived secrets in the
[credential broker](./connectors.md) where it fits.

## Listing, restarting and removing

`imp service ls` shows each service's state, pid, restart count, last exit and command. The state is
`starting`, `running`, `backoff` (waiting to restart after an exit), `exited` (ended, and its policy
does not restart it) or `stopped`. `--json` also gives:

- `source`: `image` for a file the image shipped or that was written by hand, `api` for one that
  `imp service add` wrote.
- `root`: `true` when the service runs as root, or as a user the imp cannot resolve.

`imp service restart` stops the service (SIGTERM, SIGKILL after 5 s) and starts it again from its
file, so an edit to the file applies. A file written by hand after boot starts on its first restart.
A restart resets the restart count and the backoff.

`imp service rm` stops the service and deletes its file. Its log stays in `/var/log/imp`, and
`imp logs` still prints it.

## Logs

A service's stdout and stderr go to `/var/log/imp/<service>.log` in the imp. Past 10 MiB the log
moves to `<service>.log.1`, which replaces the one before, so a service keeps at most about 20 MiB
of log ([images](./images.md#services) has the rotation rules).

`imp logs <imp> <service>` prints the last 100 lines across the two files; `-n` sets the count (0 to
100000). Without a service, it prints every service's log, each line led by `<service> | `, and the
lines are split evenly among the services, 10 000 in all at most. A line longer than 64 KiB is split
into lines of 64 KiB.

### Following a log

`-f` then keeps printing what the services write until ctrl-c, through both kinds of rotation. A
follow only watches:

- It does not wake a sleeping imp or boot a stopped one, and it does not count as activity, so the
  imp still sleeps when it is idle.
- When the imp sleeps or stops, stderr says so and the follow waits. When something else wakes the
  imp, such as a request to its URL or an `imp exec`, the follow goes on from where it stopped. Each
  service's position is its log file and the offset in it, and the rotated `.log.1` file is read
  first if the log rotated, so no line prints twice.
- When impd restarts, the follow ends, and stderr says so.
- A follow of every service gets the services that existed when it connected. A service added later
  joins after the next reconnect, at a sleep and wake.
- When the log cannot be opened 5 times in a row while the imp runs, the follow ends with the error.

`imp logs` without `-f` wakes the imp, as `imp exec` does.

## Access

Listing needs a token with the `read` scope. Adding, removing and restarting run commands in the
imp, and a log can hold anything a service prints, secrets too, so those and `imp logs` need `exec`
([tokens](./tokens.md#scopes)).

A service that runs as root gets more than an `exec` token does, since `imp exec` runs as the
image's user. So these need `manage`:

- `add` with a `--user` other than the image's user.
- `rm`, `restart` and `add --replace` on a service that runs as root, or one the imp does not list.

An `exec` token gets `FORBIDDEN` for these.

## Older imps

The services API needs agent protocol `0.10.0`. An imp that last booted with an older agent lists
its services without their commands and answers the rest with `AGENT_OUTDATED`; stop and start it to
update the agent.
