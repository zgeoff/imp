# Images

An imp boots from any OCI image. impd exports the image's filesystem into a sparse ext4 file once
per image ID, and each imp disk is a reflink clone of it
([storage](../architecture/storage.md#images-any-oci-image) covers the pipeline). The image needs no
imp bits and no init system: the guest kernel boots `imp-agent` from the read-only imp system drive
(`/dev/vdb`), stays PID 1 there, and runs the image filesystem in an
[inner container](../architecture/agent.md#the-inner-container).

| Image                           | What it is                                                               |
| ------------------------------- | ------------------------------------------------------------------------ |
| `base/` → `imp/base`            | Ubuntu 24.04, Docker engine (dockerd supervised by the agent), git, curl |
| `dev/` → `imp/dev`              | `imp/base` + Node LTS, Bun, Go, Python 3 + pip + uv, Claude Code         |
| `examples/hello/` → `imp/hello` | `imp/base` + a tiny HTTP service on :8080 (the bring-your-own example)   |

```sh
imp image build images/base --name base     # tagged imp/base
imp image build images/dev --name dev       # FROM imp/base
imp image build images/examples/hello --name hello
```

## Build an image

`imp image build <dir> --name <name>` packs the directory on the machine that runs the CLI and
uploads it to impd, which runs `docker build` on the host Docker and tags the result `imp/<name>`.
Later images can say `FROM imp/base`. `--file <path>` names a Dockerfile inside the context.

- **What goes up.** The CLI sends what `docker buildx build <dir>` would. It reads
  `<Dockerfile>.dockerignore` when there is one, else `.dockerignore`, with Docker's rules. Then
  `.dockerignore` is an ordinary file, and the ignore file can leave itself out. The Dockerfile
  always goes, because docker reads it from the context, so `COPY .` copies it even when the ignore
  file matches it. Symlinks stay links, and files keep their modes. A progress line shows on a
  terminal.
- **The stream.** The tar goes out as it is made, to `POST /images/build`, with its exact length as
  the Content-Length. Neither the CLI nor impd holds it in memory. impd writes it to a temp file
  under `<IMP_DATA_DIR>/uploads`, builds from it, and deletes it. It clears that directory when it
  starts. When the client goes, impd kills the build and frees its slot and its disk room.
- **Limits.** A context may be up to `IMP_BUILD_CONTEXT_MAX_MIB` (default 1024); a larger one fails
  with `PAYLOAD_TOO_LARGE`. At most 4 builds upload or run at once; a fifth gets
  `TOO_MANY_REQUESTS`. The disk budget holds room for the tar, for Docker's copy of it, and for the
  image ([storage](../architecture/storage.md#disk-budget)).
- **Who may build.** A token with `manage` scope and no imp patterns, as for `images.build`. Every
  build leaves an audit row.
- **What the build may do.** impd runs one fixed command:
  `docker build --quiet --build-arg BUILDKIT_SYNTAX=docker/dockerfile:1 -t imp/<name> -f <file> -`.
  The client cannot pass build arguments, secrets, `--network` or `--allow`. The Dockerfile path
  must stay inside the context. The image has no buildx, so the build runs on Docker's classic
  builder, which ignores `BUILDKIT_SYNTAX` and a `# syntax=` line, and has no `RUN --mount`.
  `imp-docker-proxy` allows only that builder
  ([the Docker socket](../architecture/host-contract.md#the-docker-socket)). The proxy closes the
  Docker socket path only: imp-host keeps `SYS_ADMIN`, which still lets root out of the container.

**CAUTION:** A `RUN` step runs on the impd host's Docker with the default bridge network. It can
reach the internet and anything the host's bridge can reach. Give `manage` only to callers you trust
with that.

`--on-host` builds from a directory on the impd host instead, and uploads nothing. The path must be
absolute and must exist where impd runs; `scripts/dev.sh` mounts the repo at its own path for this.
An image you built with plain `docker build` goes in with `imp image add <ref>`. `images/dev` takes
`--build-arg BASE=...` to stack on another base; use `docker build` and `imp image add` for that. An
imp's own disk can be an image too: a [template](./templates.md) copies a set-up imp into new ones.

The SDK has the same upload: `client.buildImage(name, context, { dockerfile, size, signal })`, where
`context` is a tar as a `Blob`, bytes or a `ReadableStream`. Give a stream's `size` so impd holds
only that much disk; without it, impd holds the whole limit. It throws an `ORPCError` as a contract
call would.

## What the guest takes from the image

- **The filesystem.** Everything in the image, as it is, except `/run`, which is a fresh tmpfs.
  `/etc/resolv.conf`, `/etc/hostname` and an empty `/etc/hosts` are rewritten by the agent at boot.
- **File capabilities and `user.*` attributes.** Of a file's extended attributes, the image keeps
  `security.capability` (what `setcap` writes, such as `cap_net_bind_service+ep` on a server that
  binds a port below 1024 without root) and `user.*`; every other one is dropped. impd needs
  `CAP_SETFCAP` for the first ([host contract](../architecture/host-contract.md#privileges)):
  without it, an image with a file capability fails to add or build. An image added by impd 0.25.1
  or older lost its file capabilities, and impd keeps that rootfs for the same image ID:
  `imp image rm <name>` and add or build it again.
- **`Env`, `WorkingDir`, `User`** from the OCI config. impd writes them to `/etc/imp/image.json`:

  ```json
  { "env": ["PATH=/root/.local/bin:..."], "workdir": "", "user": "" }
  ```

  The agent merges `env` over `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  `HOME=/root` and `TERM=xterm-256color`, and uses the result as the default for every exec and
  every service. `workdir` is the default exec cwd. `user` is the default exec and service user.

- **Not used:** `Entrypoint`, `Cmd`, `ExposedPorts`, `Volumes`, `Healthcheck`. An imp is a machine,
  not a container: long-running processes go in `services.d`.

## Services

The agent starts every file in `/etc/imp/services.d/<name>.json` at boot and restarts each service
when it exits. An image ships its services as these files; `imp service` adds, restarts and removes
them on a running imp, and `imp logs` prints their logs ([services](./services.md)).

```json
{
  "argv": ["busybox", "httpd", "-f", "-p", "8080", "-h", "/srv/hello"],
  "env": ["GREETING=hello"],
  "cwd": "/srv",
  "user": "www-data",
  "restart": "always"
}
```

| Field     | Default        | Meaning                                                |
| --------- | -------------- | ------------------------------------------------------ |
| `argv`    | required       | `argv[0]` is looked up in the `PATH` of the merged env |
| `env`     | `[]`           | `KEY=VALUE`, merged over the image env key by key      |
| `cwd`     | `/`            | working directory                                      |
| `user`    | the image user | `name`, `uid`, `name:group` or `uid:gid`               |
| `restart` | `always`       | `always`, `on-failure` or `never`                      |

- The file name, less `.json`, is the service's name, used by `imp service` and for the log file. A
  `name` field in the file is ignored. Use `^[a-z0-9][a-z0-9-]{0,62}$`: the agent starts a file with
  another name, but `imp service` cannot name it.
- Output (stdout and stderr) goes to `/var/log/imp/<name>.log`. stdin is `/dev/null`. The agent
  checks the log every 60 s and at each start; past 10 MiB it moves to `<name>.log.1`, replacing the
  previous one. A log can grow by up to 60 s of output past the cap between checks.
- Restarts back off from 1 s, doubling to 60 s. A run of 30 s or more resets the backoff.
- Run the service in the foreground. A process that forks into the background looks like an exit.
- There is no ordering between services and no readiness check. A service that needs another one
  retries on its own (or its wrapper waits).
- A bad file is logged on the console and skipped; the rest still start.
- A service file you add with `imp exec` lives on the disk, so it survives sleeps, checkpoints,
  restores and forks. It starts at the next boot, or at `imp service restart`
  ([services](./services.md)).

## Docker in the guest (`imp/base`)

- `services.d/docker.json` runs `/usr/bin/dockerd` directly. The agent mounts a fresh tmpfs on
  `/run` every boot, so no stale pid file or socket from the last boot is left to clear. dockerd
  starts its own containerd; there is no separate containerd service.
- `/etc/docker/daemon.json` sets the `cgroupfs` cgroup driver (there is no systemd; the agent mounts
  cgroup v2 at `/sys/fs/cgroup`) and the `local` log driver (compressed, rotated).
- iptables is the Ubuntu default nf_tables variant. The imp guest kernel (`kernel/`) has nftables
  and the raw table that Docker 28+ needs. The Firecracker CI kernel does not, and dockerd fails on
  it.
- Storage is the containerd image store on overlayfs, inside the imp disk.
- To leave Docker out of an image based on `imp/base`, delete the service:
  `RUN rm /etc/imp/services.d/docker.json`.

## Make your own

Any image boots. FROM `imp/base` to get Docker and the usual tools:

```dockerfile
FROM imp/base
RUN apt-get update && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*
COPY app/ /srv/app/
COPY app.json /etc/imp/services.d/app.json
ENV APP_ENV=production
```

`examples/hello/` is the smallest real case: busybox `httpd` on :8080 as a service. Inside the
guest, `curl localhost:8080` answers. The acceptance test uses it for the bring-your-own path and as
the target of the [wake proxy](../architecture/networking.md#the-wake-proxy)
(`http://<name>.imp.localhost:7080`).

Notes for images that are not FROM `imp/base`:

- Use a glibc or musl userland with `/bin/sh`; the agent itself is static and needs nothing.
- Nothing in the image runs at boot except `services.d`. There is no systemd, no cron, no sshd.
