# SSH

impd has an SSH gateway. `ssh box@imp` lands in the imp `box`, and wakes it first if it sleeps. Any
SSH client works: `ssh`, `scp`, `sftp`, git over SSH, and editors that open a remote folder over
SSH, such as VS Code Remote SSH. The [daemon page](../architecture/daemon.md#ssh-the-gateway) covers
how it works inside impd.

## Set up

1. Add your public key to `authorized_keys` in the `ssh` directory of the data directory:
   `/var/lib/imp/ssh/authorized_keys` on a server, and in the host container. The file and its
   directory must not be writable by group or others. impd reads the file again when it changes, so
   a new key works on the next login.

   ```sh
   # a server: /var/lib/imp is the host's bind mount
   sudo install -d -m 700 /var/lib/imp/ssh
   cat ~/.ssh/id_ed25519.pub | sudo tee -a /var/lib/imp/ssh/authorized_keys
   sudo chmod 600 /var/lib/imp/ssh/authorized_keys

   # the dev instance
   docker exec -i imp-dev sh -c 'umask 077; cat >> /var/lib/imp/ssh/authorized_keys' < ~/.ssh/id_ed25519.pub
   ```

2. Check the host key on the first connection. impd logs its fingerprint when it starts:

   ```text
   impd: ssh on :22, host key SHA256:…
   ```

3. Add this to `~/.ssh/config`. `imp` is the host's tailnet name; for the dev instance, use
   `HostName 127.0.0.1` and `Port 2222`.

   ```text
   Host imp
     IgnoreUnknown WarnWeakCrypto
     WarnWeakCrypto no
   ```

   OpenSSH 10.1 and later warn on every connection that does not use a post-quantum key exchange.
   The gateway's SSH library has none, so `WarnWeakCrypto no` turns the warning off for this host.
   On the tailnet, the connection also runs inside WireGuard. `IgnoreUnknown` lets an older OpenSSH
   read the file.

Then:

```sh
ssh box@imp                  # a login shell
ssh box@imp 'uname -a'       # one command
scp notes.txt box@imp:/tmp/  # copy a file
sftp box@imp
```

For an editor, give each imp its own host:

```text
Host box.imp
  HostName imp
  User box
  IgnoreUnknown WarnWeakCrypto
  WarnWeakCrypto no
```

## Users, keys and imps

- The SSH user names the imp. Commands run as the image's user (its `USER`, else root), as with
  `imp exec`.
- Every key in `authorized_keys` reaches every imp. imp has one owner.
- A line with options (`from=`, `command=`, `restrict`, ...) is skipped, and impd logs why. The
  gateway cannot enforce options, so it does not grant what they would limit. ed25519, ECDSA and RSA
  keys work. FIDO (`sk-`) and DSA keys do not.
- An unknown imp and an unknown key get the same `Permission denied (publickey)`, so nobody can
  probe for imp names. A refused login wakes nothing.
- Tailscale identity (logins checked with `tailscale whois`, as Tailscale SSH does) is not built
  yet. It needs the peer's real address, which the gateway gets because it listens on the tailnet
  directly, not behind `tailscale serve`.

## What works

| Request                              | What happens                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| shell (`ssh box@imp`)                | the user's login shell from the image's `/etc/passwd`, else bash, else sh, on a pty                 |
| command (`ssh box@imp cmd`)          | `/bin/sh -c cmd`, with its exit status, or the signal that ended it                                 |
| pty and window size                  | the client's size and `TERM`; resizes follow                                                        |
| signals                              | sent to the command's process group                                                                 |
| SFTP, `scp`                          | the SFTP server on the system drive, so every image has it                                          |
| local forward (`-L`, `-D`)           | to `localhost`, `127.0.0.1` or `::1` in the imp, including programs that listen on loopback only    |
| unix socket forward (`-L` to a path) | to any socket path in the imp                                                                       |
| env (`SendEnv`, `SetEnv`)            | `LANG` and `LC_*` only. `SSH_CONNECTION` and `SSH_CLIENT` are set as sshd sets them                 |
| credential connectors                | an imp with a grant gets the broker's variables, as with `imp exec` ([connectors](./connectors.md)) |
| remote forward (`-R`)                | refused                                                                                             |
| agent forwarding (`-A`)              | a socket in the imp for `SSH_AUTH_SOCK` ([below](#agent-forwarding))                                |
| X11                                  | refused                                                                                             |

A forward to any other host is refused as administratively prohibited. Otherwise the gateway would
be a way into other imps, the host container or the network beyond.

`scp` uses SFTP since OpenSSH 9.0. `scp -O` (the old protocol) and `rsync` run their own programs in
the imp, so the image needs `scp` or `rsync` for them.

The SFTP server and port forwarding need the agent from protocol `0.3.0`, and agent forwarding from
`0.4.0`. An imp that still runs an older agent answers with `AGENT_OUTDATED`; stop and start it to
update it ([operations](./operations.md#upgrade)).

## Agent forwarding

`ssh -A box@imp` (or `ForwardAgent yes`) lets commands in the imp use the ssh-agent on your machine:
`git push` over SSH signs with your key, and the key never reaches the imp.

```sh
ssh -A box@imp
ssh-add -l                    # your keys, from your machine
git push                      # signed by your agent
```

- The imp gets a socket at `/run/imp/ssh-agent/<random>/agent.sock` and `SSH_AUTH_SOCK` points at
  it. As with sshd, forwarding belongs to the connection: once a session asks, every later session
  of that connection gets it, and SFTP never does.
- The socket and its directory belong to the image's user (mode 0600 and 0700), and the agent also
  checks each client's uid: only that user and root get through. The socket goes when the connection
  ends, and `/run` starts empty on every boot.
- A forced sleep (`imp sleep`) ends the socket; the connection's next session gets a new one.
- Without an agent on your machine, `ssh-add` in the imp fails at once. An imp opens at most 16
  agent channels at a time per connection; more of its clients are closed.
- Without agent forwarding in the imp's agent, a command still runs, without `SSH_AUTH_SOCK`, and
  stderr says why. OpenSSH asks for forwarding without waiting for an answer, so there is no other
  way to tell it.

> **WARNING:** Forward your agent only to an imp whose other users you trust with your keys. Every
> SSH login runs as the same image user, so any key in `authorized_keys` can use your forwarded
> agent while you are connected, and so can root in the imp: in images that run as root, that is
> every command. They cannot copy your key, but they can sign with it until you disconnect.
> `ssh-add -c` makes your agent ask before each use.

## Sleep and wake

- A login starts the imp's wake at once. A sleeping imp wakes in about 0.2 s from `ssh` to the first
  command's output.
- An open connection keeps the imp awake, with or without a command running. The idle timeout counts
  from when the connection closes.
- The gateway sends a keepalive every 15 s and drops a client that misses 3, so a client that
  vanished without closing does not keep its imp awake.
- When the imp cannot wake, for example with `RAM_BUDGET_EXCEEDED`, the login still works, and each
  command fails with the reason on stderr and exit status 255.
- `imp sleep` with a connection open ends the commands it runs (they get SIGHUP), and the next
  command wakes the imp again.
- impd closes every SSH connection when it stops.

## Where it listens

`IMP_SSH_PORT` (default 22, `0` turns the gateway off) on IPv4, in the host container's own network
namespace. That namespace has the tailnet (`tailscale0`), the container's own link and the imps'
taps. The firewall drops guest traffic to the host container over IPv4 and IPv6
([networking](../architecture/networking.md#iptables)), so an imp cannot reach the gateway.

- On the tailnet, `ssh box@imp` reaches it on port 22. The ACL decides who can connect.
- The compose file and the systemd unit publish nothing for SSH.
- `scripts/dev.sh` publishes it on `127.0.0.1:2222` (plus `IMP_DEV_PORT_OFFSET`).

The host key is `<data>/ssh/host_key` (ed25519, owner-only), made on the first start. The data
directory outlives the container, so the key stays the same across restarts and upgrades.
