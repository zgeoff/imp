# Install

imp runs on one Linux machine. Today the way to run it is `scripts/dev.sh`, which builds the host
container from `host/` and runs impd from the repo. A versioned production image and a one-command
server bootstrap are on the [roadmap](https://github.com/zgeoff/imp/issues/41)
([#7](https://github.com/zgeoff/imp/issues/7), [#9](https://github.com/zgeoff/imp/issues/9)).

## Needs

- `/dev/kvm`: bare metal, or a VM with nested virtualization (WSL2 works).
- Docker. The host container is privileged and mounts the Docker socket.
- [Bun](https://bun.sh) for the CLI, and Go for the guest agent.
- Disk for the sparse XFS file. `IMP_STORAGE_GIB` (default 200) sets its apparent size; it uses only
  what imps write.

## Set up

1. Clone the repo and install the dependencies:

   ```sh
   git clone https://github.com/zgeoff/imp && cd imp
   bun install
   ```

2. Build the guest kernel. The first build takes about 9 minutes; the
   [kernel README](../../kernel/README.md) has the details.

   ```sh
   kernel/build.sh
   ```

3. To put imps on your tailnet, write a tagged auth key to `.env` in the repo root. The
   [Tailscale guide](./tailscale.md) covers the key and the ACL.

   ```sh
   TAILSCALE_AUTHKEY=tskey-auth-…
   ```

4. Start impd. `up` builds the host image and the system drive when they are missing, starts the
   container, and waits until impd reports ready.

   ```sh
   scripts/dev.sh up
   ```

5. Give the CLI the token:

   ```sh
   export IMP_TOKEN=$(scripts/dev.sh token)
   ```

   Or write it to `~/.config/imp/token` once.

6. Check it:

   ```sh
   imp info
   imp new box && imp exec box -- uname -a
   ```

**NOTE:** The guides write `imp` for the CLI. From the repo, `scripts/imp` runs it; link it onto
your `PATH` as `imp`, or use `scripts/imp` in its place.

[Configuration](./configuration.md) lists every variable, and [operations](./operations.md) covers
restarts and day-to-day care.

## What `dev.sh up` does

- Builds `host/` as the host image, and `build/imp-system.squashfs` (the agent's system drive) when
  it is missing.
- Starts the container with `--privileged --device /dev/kvm`, the Docker socket, and the repo
  mounted at `/src` and at its own path.
- Keeps data in `.data/dev/imp.xfs`, a sparse XFS file that the container loop-mounts on
  `/var/lib/imp`.
- Publishes the API on 7070, the proxy on 7080, and per-imp ports 20000–20063.

## WSL2 notes

- The WSL 6.6 kernel rejects newer `mkfs.xfs` defaults. `setup-storage.sh` passes
  `-i nrext64=0,exchange=0 -n parent=0`.
- WSL's uplink MTU is 1360. `dev.sh` passes it to the container, which clamps guest TCP MSS to
  match.
- If the host runs Tailscale with MagicDNS, the container uses public resolvers instead, because its
  own tailscaled would capture `100.100.100.100`.

## Bare metal

On a bare-metal host, put `/var/lib/imp` on a real XFS partition with reflink, and use a
non-ephemeral tagged Tailscale key. Expect faster boots and wakes than on a nested-virtualization
dev box.
