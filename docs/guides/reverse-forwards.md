# Reverse forwards

`imp proxy --reverse` lets a program in an imp reach a unix socket or a port on your machine: an
agent in the imp talks to a service on your laptop, or a build in the imp reaches a database you run
locally. It is `ssh -R` without SSH: it goes to impd with the CLI's token, and needs `exec` scope on
the imp ([tokens](./tokens.md#scopes)). `ssh -R` works too ([SSH](./ssh.md#remote-forwards)).

```sh
imp proxy box --reverse /tmp/app.sock:/run/user/1000/app.sock   # a socket in the imp to one here
imp proxy box --reverse 9000:8080                               # 127.0.0.1:9000 in the imp to localhost:8080
imp proxy box --reverse 0:8080                                  # any free port in the imp; it prints which
imp proxy box --reverse :/run/user/1000/app.sock                # a socket path the imp's agent picks
imp proxy box 5432 --reverse 9000:8080                          # both directions at once
```

Each `--reverse` is `GUEST:LOCAL`, and `--reverse` repeats. Each side is an absolute socket path or
a port, and a lone side is both: `--reverse 9000` is `9000:9000`. An empty `GUEST` is a socket the
imp's agent makes under `/run/imp/forward/`. The CLI prints one line for each forward, such as
`forwarding box:/tmp/app.sock -> /run/user/1000/app.sock`, and relays until Ctrl-C.

## In the imp

- The forward listens as the image's USER, the user `imp exec` runs as. A socket path must be one
  that user may make, in a directory that exists; impd's own `/run/imp/` is refused. A socket left
  at the path by an earlier forward is replaced; any other file there is refused.
- A socket is mode 0600, and only the image's user and root get through. A port listens on the imp's
  `127.0.0.1` only, never an address another machine reaches. A port below 1024 is refused unless
  the user is root.
- A forward relays at most 64 connections at a time; more are closed. The forward and each of its
  connections count toward the imp's 256 open tunnels.

> **CAUTION:** A port in the imp is open to every process and every user in the imp, as an `ssh -R`
> port is with sshd. For a service that acts for you, such as a coding agent's control socket, use a
> socket path: it admits only the image's user and root.

## Sleep and wake

- An open connection through a forward keeps the imp awake, as an `imp proxy` connection does. The
  forward alone does not: an imp with no traffic on it sleeps on its idle timeout.
- A sleep ends the forward in the imp. The CLI then waits for the imp to wake, without waking it,
  and listens again at the same path or port; it prints a notice each way. A port 0 forward may get
  a new port. If the listener ended while the imp stayed awake, the CLI listens again after 30 s.
- When impd restarts, the CLI tries again every 2 s and listens once the imp runs.
- The first listen wakes the imp. A forward that impd refuses ends the command with the reason, such
  as `LISTEN_FAILED: port 80 needs root in the imp; pick a port above 1023`.
- Each forward is in the [audit log](./events.md#the-api-audit-log) as `reverse:<path or port>`.

Reverse forwards need the imp's agent from protocol `0.9.0`; an older one answers `AGENT_OUTDATED`.
Stop and start the imp to update it ([operations](./operations.md#upgrade)).

## From code

`openReverseForward` in `@zgeoff/imp-client` opens a forward over impd's `/tunnel` socket. Its
`onConnection` gets each client in the imp, for the caller to relay where it likes; `ended` says
`lost` when a sleep ended the forward, and the caller listens again once the imp runs. The protocol
is in [daemon](../architecture/daemon.md#reverse-forwards).
