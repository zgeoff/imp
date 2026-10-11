# The CLI

`imp` is the command line for impd. It saves the hosts it logs in to, each with its token, and
`--host` or `imp use` picks one. `scripts/imp` runs it from the repo.

| Command                                   | What it does                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `new [name]`                              | create and boot an imp (`--image`, `--cpus`, `--memory`, `--disk`)        |
| `ls`, `info`                              | list imps; show RAM use and the budget                                    |
| `exec <name> -- cmd`                      | run a command (`-t` for a terminal)                                       |
| `console <name>`                          | open a shell in a session that outlives the terminal                      |
| `sessions <name>`, `attach <name>`        | list sessions; attach to one from any machine                             |
| `service add`, `ls`, `restart`, `rm`      | manage the processes an imp keeps running                                 |
| `logs <name> [service]`                   | print a service's log (`-f` to follow)                                    |
| `checkpoint`, `checkpoints`, `restore`    | save, list and roll back disk states                                      |
| `fork <source> <name>`                    | copy an imp's disk, or a checkpoint (`--from`)                            |
| `move <name> <host>`                      | move an imp to another saved host (`--stop` for a cold move)              |
| `disk resize <name> <size>`               | grow an imp's disk; the guest grows into it                               |
| `gc [--dry-run]`                          | remove storage no imp, checkpoint or image names                          |
| `backup run`, `ls`, `restore`, `check`    | back imps up off the host and restore them                                |
| `sleep`, `wake`, `hold <name> <time>`     | sleep by hand; keep an imp awake for a while                              |
| `start`, `stop`, `rm`                     | boot cold, shut down, destroy                                             |
| `set <name>`, `top`                       | change CPU limit, weight, vCPUs; watch resource use                       |
| `url <name>`                              | print the imp's local and tailnet URLs, and its own tailnet name          |
| `proxy <name> <port>...`                  | reach ports in the imp from this machine (`--reverse` the other way)      |
| `cp <src> <dest>`                         | copy files and directories into or out of an imp                          |
| `policy <name> [open\|public\|box\|none]` | show or set what the imp may reach (`--allow` for box)                    |
| `net create`, `ls`, `rm`, `join`, `leave` | private networks between imps (`imp new --net`)                           |
| `expose <name>`, `unexpose <name>`        | serve the imp to the internet on your domain (`--auth token\|basic`)      |
| `image build`, `add`, `ls`, `rm`          | manage images                                                             |
| `template create`, `ls`, `rm`             | make an image from an imp's disk, to create imps from                     |
| `secret add`, `ls`, `refresh`, `rm`       | store API tokens in impd, never in a guest; renew OAuth ones              |
| `grant`, `revoke`, `grants`, `audit`      | let an imp use a token through the host-side broker                       |
| `events [name]`                           | follow impd's events as JSON lines                                        |
| `mcp --prefix <p>`                        | serve imps to a coding agent as MCP tools over stdio                      |
| `token new`, `ls`, `rm`, `key`, `whoami`  | scoped API tokens and their SSH keys, limited to some imps if you like    |
| `login <url>`, `host ls`, `use`, `rm`     | save impd hosts and their tokens; pick one (`--host`); `hosts` lists them |
| `completion bash\|zsh\|fish`              | print the shell completion script                                         |

`--memory` and `--disk` take MiB or a unit (`512m`, `2g`, `1t`); a disk is 32 GiB by default.
`imp new` and `imp set` take `--cpu-limit` and `--cpu-weight` ([CPU limits](./cpu-limits.md)).
`--max-memory` (up to 4 × `--memory`) lets the guest grow under memory pressure and shrink when idle
([elastic memory](../architecture/lifecycle/elastic-memory.md)). [Connectors](./connectors.md)
covers secrets and grants; [tokens](./tokens.md) covers scopes and tailnet identity. Commands that
print imps, images, checkpoints or `info` take `--json`. `scripts/imp` runs the CLI from the repo.

Other commands exit 0, 1 when impd refuses the call, or 2 for a usage error (an unknown flag, a bad
size, a relative `image build --on-host` path, an `IMP_URL` that is not an http URL, an unknown
`--host`). `imp exec` and `imp console` exit with the command's own code, or 128 + n when signal n
ended it, and set these codes themselves:

| Code | When                                                                                 |
| ---- | ------------------------------------------------------------------------------------ |
| 2    | a usage error, such as no command after `--`                                         |
| 127  | the command could not start (`EXEC_FAILED`)                                          |
| 141  | the CLI's own output closed, as in `imp exec box -- cat big \| head`                 |
| 254  | another terminal attached to the session and took it over                            |
| 255  | imp failed: impd unreachable, a rejected token, an unknown imp, a dropped connection |

`imp console box` starts the session `main`, or attaches to it if it runs (`--session <name>` names
another, `--no-session` gives a shell that ends with the terminal). Without a terminal on stdin, as
in a script, it runs without a session unless `--session` names one. Ctrl-] detaches
(`--detach-key ctrl-<key>` or `none`; Escape, Backspace, Tab, Enter and Return cannot be the key),
and closing the terminal does too: the shell keeps running in the imp, and through a sleep.
`imp sessions box` lists the sessions without waking the imp, `imp attach box [main]` shows the
session's recent output and goes on live from any machine, and `imp sessions kill box main` ends
one. One terminal is attached at a time: a new attach takes the session over. When impd restarts,
the imp sleeps, or the connection drops under an attached terminal, the CLI attaches again by itself
for up to 60 s, waiting 1 s, then 2 s, then 4 s and at most 8 s between tries. Meanwhile the detach
key still detaches and Ctrl-C gives up (130); other keys wait for the session. It does not attach
again once another terminal attached. A detach exits 0.

A signal to the CLI (Ctrl-C without `-t`, SIGTERM, SIGHUP) goes to the command, except in a session,
where it detaches; a second one ends the session with 128 + n, so the CLI stops even when the
command ignores it or impd stopped answering. A signal before the command starts ends the session at
once, also with 128 + n. With `-t`, Ctrl-C is a key the command reads.
