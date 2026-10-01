# Images

An imp boots from any OCI image. impd exports the image's filesystem into a sparse ext4 file once
per image ID, and each imp disk is a reflink clone of it (DESIGN.md 2.4, 2.5). The image needs no
imp bits and no init system: the guest kernel boots `imp-agent` from the read-only imp system drive
(`/dev/vdb`), switches root to the image filesystem, and stays PID 1 there.

| Image                           | What it is                                                               |
| ------------------------------- | ------------------------------------------------------------------------ |
| `base/` → `imp/base`            | Ubuntu 24.04, Docker engine (dockerd supervised by the agent), git, curl |
| `dev/` → `imp/dev`              | `imp/base` + Node LTS, Bun, Go, Python 3 + pip + uv, Claude Code         |
| `examples/hello/` → `imp/hello` | `imp/base` + a tiny HTTP service on :8080 (the bring-your-own example)   |

```sh
docker build -t imp/base images/base
docker build -t imp/dev images/dev             # --build-arg BASE=... to stack on another base
docker build -t imp/hello images/examples/hello
```

## What the guest takes from the image

- **The filesystem.** Everything in the image, as it is. `/etc/resolv.conf`, `/etc/hostname` and an
  empty `/etc/hosts` are rewritten by the agent at boot.
- **`Env`, `WorkingDir`, `User`** from the OCI config. The rootfs builder writes them to
  `/etc/imp/image.json`:

  ```json
  { "env": ["PATH=/root/.local/bin:..."], "workdir": "", "user": "" }
  ```

  The agent merges `env` over `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  `HOME=/root` and `TERM=xterm-256color`, and uses the result as the default for every exec and
  every service. `workdir` is the default exec cwd. `user` is the default exec and service user.

- **Not used:** `Entrypoint`, `Cmd`, `ExposedPorts`, `Volumes`, `Healthcheck`. An imp is a machine,
  not a container: long-running processes go in `services.d`.

## Services: `/etc/imp/services.d/<name>.json`

The agent starts every file in this directory at boot and restarts each service when it exits.

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
| `name`    | the file name  | the name in `services.list` and the log file name      |
| `env`     | `[]`           | `KEY=VALUE`, merged over the image env key by key      |
| `cwd`     | `/`            | working directory                                      |
| `user`    | the image user | `name`, `uid`, `name:group` or `uid:gid`               |
| `restart` | `always`       | `always`, `on-failure` or `never`                      |

- Output (stdout and stderr) goes to `/var/log/imp/<name>.log`. stdin is `/dev/null`.
- Restarts back off from 1 s, doubling to 60 s. A run of 30 s or more resets the backoff.
- Run the service in the foreground. A process that forks into the background looks like an exit.
- There is no ordering between services and no readiness check. A service that needs another one
  retries on its own (or its wrapper waits).
- A bad file is logged on the console and skipped; the rest still start.
- Services added through the imp API are written to the same directory, so they live on the disk and
  survive checkpoints, restores and forks.

## Docker in the guest (`imp/base`)

- `services.d/docker.json` runs `dockerd` directly. The agent mounts a fresh tmpfs on `/run` every
  boot, so no stale pid file or socket from the last boot is left to clear. dockerd starts its own
  containerd; there is no separate containerd service.
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
the target of the wake proxy (`http://<name>.imp.localhost:7080`, DESIGN.md 2.11).

Notes for images that are not FROM `imp/base`:

- Use a glibc or musl userland with `/bin/sh`; the agent itself is static and needs nothing.
- Nothing in the image runs at boot except `services.d`. There is no systemd, no cron, no sshd.
