# Images

An imp boots from any OCI image. impd exports the image's filesystem into a sparse ext4 file once
per image ID, and each imp disk is a reflink clone of it
([storage](../architecture/storage.md#images-any-oci-image) covers the pipeline). The image needs no
imp bits and no init system: the guest kernel boots `imp-agent` from the read-only imp system drive
(`/dev/vdb`), switches root to the image filesystem, and stays PID 1 there.

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

`imp image build` runs `docker build` on the host Docker and tags the result `imp/<name>`, so later
images can say `FROM imp/base`. The CLI sends the absolute path of the directory, and impd builds
from that path, so the directory must exist at the same path in the host container. `scripts/dev.sh`
mounts the repo at its own path for this. An image you built with plain `docker build` goes in with
`imp image add <ref>`. `images/dev` takes `--build-arg BASE=...` to stack on another base; use
`docker build` for that.

## What the guest takes from the image

- **The filesystem.** Everything in the image, as it is, except `/run`, which is a fresh tmpfs.
  `/etc/resolv.conf`, `/etc/hostname` and an empty `/etc/hosts` are rewritten by the agent at boot.
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
when it exits.

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
- A service file you add with `imp exec` lives on the disk, so it survives sleeps, checkpoints,
  restores and forks. It starts at the next boot. An API to manage services is not there yet
  ([#23](https://github.com/zgeoff/imp/issues/23)).

## Docker in the guest (`imp/base`)

- `services.d/docker.json` runs `/usr/local/libexec/imp/dockerd`, a wrapper that execs `dockerd`. It
  also clears stale `/run` state when `/run` is not a tmpfs; the agent mounts a fresh tmpfs there
  every boot, so that step does nothing today. dockerd starts its own containerd; there is no
  separate containerd service.
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
