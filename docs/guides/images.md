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
| `coder/` → `imp/coder`          | the published base + Claude Code and gh at pinned versions, no Node      |
| `dev/` → `imp/dev`              | the published base + Node LTS, Bun, Go, Python 3 + pip + uv, Claude Code |
| `examples/hello/` → `imp/hello` | the published base + a tiny HTTP service on :8080 (bring-your-own)       |

```sh
imp image build images/dev --name dev       # FROM the published base, by digest
imp image build images/coder --name coder   # or add the published imp-coder, below
imp image build images/examples/hello --name hello
imp image build images/base --name base     # optional: your own imp/base
```

Each release also publishes `images/base` as `ghcr.io/zgeoff/imp-base:X.Y.Z`, linux/amd64 only, with
a provenance attestation. A published tag never moves, but pin it by digest anyway
(`FROM ghcr.io/zgeoff/imp-base:X.Y.Z@sha256:…`): the digest names the exact bytes, and
`gh attestation verify oci://ghcr.io/zgeoff/imp-base:X.Y.Z -R zgeoff/imp` checks where they came
from ([releasing](../../RELEASING.md#what-a-release-ships)).

## The coder image

Each release also publishes `images/coder` as `ghcr.io/zgeoff/imp-coder:X.Y.Z`, linux/amd64 only,
with a provenance attestation, so a host runs a coding agent without a build:

```sh
imp image add ghcr.io/zgeoff/imp-coder:X.Y.Z@sha256:… --name coder
imp new work --image coder
```

It is the published base by digest plus the Claude Code binary at the exact version its Dockerfile
pins, in `/usr/local/bin/claude`, checked against the sha256 from Anthropic's signed release
manifest. It has no Node: the binary does not need it. The binary is owned by root in
`/usr/local/bin`, which is what pins the version; `DISABLE_UPDATES=1` in the image keeps updates off
by default. A release builds it FROM the base its Dockerfile pins, which is the base of an earlier
release: the FROM line is a literal digest, since a build of the same release's base has no digest
until it is pushed. Bumping the base or Claude Code is a reviewed change; the Dockerfile comment
gives the steps to check a new Claude Code version.

The image also holds the GitHub CLI, `gh`, in `/usr/local/bin/gh`, at the exact version its
Dockerfile pins and checked against the sum from the release's checksums file. An agent uses it to
open pull requests. Grant the imp a `github` secret and `gh` works with no sign-in: impd sets
`GH_TOKEN` to a placeholder, and the broker adds the token
([credential connectors](./connectors.md)).

## Add an image

`imp image add <ref> [--name <name>]` makes an image from a public registry reference. By default
(`IMP_BUILD_ISOLATION=imp`) impd does it in a builder imp, as it does a build, and the host's Docker
engine never has the image:

1. impd creates a builder imp, as step 2 of an [isolated build](#isolated-builds) does. The governor
   and the disk budget admit it as any imp; a refusal fails the add and never falls back to the
   host.
2. The builder's dockerd pulls the reference for the builder's platform (`linux/amd64` on an x86
   host), under the `public` egress policy. A reference with no tag and no digest means `:latest`,
   and impd writes it out. The builder holds no registry credentials, so a private image does not
   pull. Before any builder boots, impd refuses a registry named `localhost` or by an IP address,
   which needs no resolver to reach the host. A registry name that resolves to a private address
   fails in the builder's resolver; one that resolves to the host's public address meets the
   `public` policy's deny list, which `IMP_HOST_ADDRESSES` fills
   ([public](../architecture/networking.md#public)).
3. impd streams `docker export` out of the builder into the host's `tar` unpack, with every limit of
   an isolated build's step 5, and computes the image's `imp-build-` digest as a build does.
4. impd destroys the builder, on success, failure or a client that goes.

An add costs a builder boot and a cold pull, about 6 to 10 s for a small image. impd logs each add
as `pull=… image=…`, with the platform and the registry's digest. The first-start `ubuntu` seed is
an add too.

Before the first add or build, impd pulls its builder image (`IMP_BUILD_IMAGE`) onto the host's
engine and gives that pull 10 minutes; on a slow link, run `docker pull <IMP_BUILD_IMAGE>` on the
host first, with the exact reference, and impd uses that image without a pull.

An image that only the host's Docker has, such as one from a plain `docker build`, does not add this
way: build it with `imp image build` instead. `IMP_BUILD_ISOLATION=host` adds from the host's Docker
engine, as before 0.36.0, for one release only, with the credentials in impd's Docker config. impd
logs a warning at start and at every such add.

## Build an image

`imp image build <dir> --name <name>` packs the directory on the machine that runs the CLI and
uploads it to impd, which builds it with BuildKit in a throwaway builder imp
([isolated builds](#isolated-builds)) and adds the result as the image `<name>`. `--file <path>`
names a Dockerfile inside the context. A later image can start FROM an image you built this way on
Docker's containerd image store, where impd pins it by its content digest (Docker 29.8 builds from
that pin, 29.7 does not; see the digest the build uses, below). The classic store refuses it
([#156](https://github.com/zgeoff/imp/issues/156)). The published base, `ghcr.io/zgeoff/imp-base` by
digest as `images/dev` names it, works on both.

- **What goes up.** The CLI sends what `docker buildx build <dir>` would. It reads
  `<Dockerfile>.dockerignore` when there is one, else `.dockerignore`, with Docker's rules. Then
  `.dockerignore` is an ordinary file, and the ignore file can leave itself out. The Dockerfile
  always goes, because docker reads it from the context, so `COPY .` copies it even when the ignore
  file matches it. Symlinks stay links, and files keep their modes. On a terminal, a progress line
  shows the upload, then how long impd has built.
- **The stream.** The tar goes out as it is made, to `POST /images/build`, with its exact length as
  the Content-Length. Neither the CLI nor impd holds it in memory. impd writes it to a temp file
  under `<IMP_DATA_DIR>/uploads`, builds from it, and deletes it. It clears that directory when it
  starts. When the client goes, impd ends the build request, which stops the build on the engine,
  and frees its slot and its disk room.
- **The answer.** A client that sends `Accept: application/x-ndjson` gets the answer as a stream,
  one JSON event per line. impd sends the headers and a first event as soon as it takes the build,
  and a progress event every 15 s and at each new phase. The last event holds the image or the
  error:

  ```json
  {"type":"progress","phase":"upload","elapsedMs":0}
  {"type":"progress","phase":"build","elapsedMs":15000}
  {"type":"image","image":{"name":"dev","ref":"imp/dev:latest","...":"..."}}
  ```

  An error ends the stream as `{"type":"error","code":"...","message":"..."}`, with the code an oRPC
  call would give. A client skips an event type it does not know. The stream exists because a
  client's fetch gives up on a response that stays silent: Bun's fetch (1.4.2) after 360 s without a
  byte, before the headers or between two chunks, unless the call passes `timeout: false`. Node's
  fetch (undici) waits 300 s for the headers (`headersTimeout`) and 300 s between two chunks of the
  body (`bodyTimeout`). A build can take longer than that. A client that sends no such `Accept`, as
  an older CLI, gets the image or the error as JSON when the build ends, and still fails on a build
  longer than its fetch waits. `system.info` lists `imageBuildStream` among the features of an impd
  that streams. The CLI asks for the stream and reads JSON from an impd that answers JSON.

  impd's own call to the engine and imp-docker-proxy's call to the engine pass `timeout: false`, so
  a `RUN` step that prints nothing for longer than 360 s does not end the build. The client's going
  still ends it.

- **Limits.** A context may be up to `IMP_BUILD_CONTEXT_MAX_MIB` (default 1024); a larger one fails
  with `PAYLOAD_TOO_LARGE`. At most 4 builds upload or run at once, uploads and builds together; a
  fifth gets `TOO_MANY_REQUESTS`. impd refuses the build with its real HTTP status when it can tell
  before it answers: auth, the query, a Content-Length over the limit, and a fifth build. A stream
  answers 200 first, so a context that grows past the limit as it uploads, or a failed build, ends
  the stream with an error event. The disk budget holds room for the tar, its rewrite, and, as the
  export streams, twice what it has written so far for the unpacked image and its ext4 file, in 256
  MiB steps; a disk that fills stops the export with `DISK_FULL`
  ([storage](../architecture/storage.md#disk-budget)). Each build's builder imp takes a slot, its
  memory and its disk like any imp.
- **Who may build.** A token with `manage` scope and no imp patterns, as for `images.build`. Every
  build leaves an audit row.
- **What the build may do.** impd runs one fixed BuildKit build: in a builder, `docker build -` with
  the tar on stdin; on the host, `POST /build?version=2` with the tar as the body and no session.
  The client gives only the name and the Dockerfile path, which must stay inside the context; it
  cannot pass build arguments, secrets, SSH agents, `--network` or `--allow`. `BUILDKIT_SYNTAX` pins
  the Dockerfile frontend by digest (`docker/dockerfile:1.19`, as in `host/Dockerfile`), so a
  `# syntax=` line is ignored. `RUN --mount=type=cache` works; `RUN --network=host` and
  `RUN --security=insecure` fail the build. A failed host build shows BuildKit's error, without the
  `RUN` step's output. The engine pulls the frontend from Docker Hub when it lacks it.
  `imp-docker-proxy` allows only this build
  ([the Docker socket](../architecture/host-contract.md#the-docker-socket)). The proxy closes the
  Docker socket path only: imp-host keeps `SYS_ADMIN`, which still lets root out of the container.
- **Images the build names.** Before the build, impd pulls each image that a `FROM`, a `COPY --from`
  or a `RUN --mount=from=` names and the engine that builds does not have yet. In a builder that is
  a cold pull with no credentials. A host build has no session, so BuildKit cannot ask for
  credentials there; impd pulls as a host `imp image add` does, with the credentials in impd's
  Docker config. It skips `scratch` and the Dockerfile's own stages. impd inspects each image once,
  for the engine's platform, and refuses an image the host has for another platform, and any image
  the build names whose config holds `ONBUILD` triggers: the frontend runs the triggers of a
  `COPY --from` or a `RUN --mount=from=` image too, in this build.
- **The digest the build uses.** The Dockerfile the engine gets names each of those images by the
  registry digest of the image impd inspected: `FROM busybox:1.37` becomes `FROM busybox@sha256:…`,
  so a tag that moves in the registry after the pull does not change the build. impd picks the
  digest under the image's own repository, else another of its registry digests, which holds the
  same content. An image with no registry digest is refused:

  ```text
  FROM imp/base: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; build FROM a registry image by tag or digest. Local base images are not supported yet (#156).
  ```

  With Docker's classic image store, an image built on the host has no registry digest, and impd
  refuses it (#156). With the containerd image store, each tag has a digest under its own name, so
  impd pins a base built on the host by its content digest. Docker 29.8 builds from that pin; Docker
  29.7 asks the registry for the name and fails the build. A tag you put on a pulled multi-platform
  image (`docker tag busybox:1.37 imp/x`) cannot be pinned on the containerd store: the engine asks
  the registry for `imp/x@sha256:…` and fails. impd then adds a line to the error that names the
  pin; build FROM the original repository, `busybox:1.37`, instead of the retag. A build never uses
  such an image by its tag alone, and impd's log line for each build names the image store.

  `FROM --platform=$BUILDPLATFORM` and `$TARGETPLATFORM` become the engine's platform, such as
  `--platform=linux/amd64`. A Dockerfile with `# check=error=true` then fails the frontend's
  `FromPlatformFlagConstDisallowed` check; skip that check, or leave `--platform` out.

- **What impd refuses before the build.** impd reads the Dockerfile as the pinned frontend parses
  it, and refuses with `BAD_REQUEST`:
  - an `ADD` from a URL or a git remote (`http://`, `https://`, `git://`, `ssh://`,
    `user@host:path`), which the engine would fetch from the host's network;
  - a variable (`$`) in `FROM`, in an `ADD` source, in `COPY --from` or in `RUN --mount=from=`. impd
    passes no build arguments, so write the image or the source literally;
  - any `ONBUILD`;
  - `FROM --platform` with any value but `$BUILDPLATFORM` or `$TARGETPLATFORM`, written so, and an
    `ARG` of `BUILDPLATFORM`, `BUILDOS`, `BUILDARCH`, `BUILDVARIANT`, `TARGETPLATFORM`, `TARGETOS`,
    `TARGETARCH` or `TARGETVARIANT` in any stage: impd builds for the engine's platform only;
  - an ambiguous form: a quote, the escape character or a character that is not printable ASCII in a
    `FROM` word, an `ADD` source or the flags of `FROM`, `ADD`, `COPY` and `RUN`, since the
    frontend's lexer would read it another way than impd does.

  These checks are narrow input and trigger rejection, not build-network isolation. They leave open:
  - a registry whose DNS name resolves to a private or loopback address: the pull rule reads the
    name, not the address;
  - a `RUN` step, which reaches the network through the host's bridge (the caution below);
  - a base image built on the host, which does not build until
    [#156](https://github.com/zgeoff/imp/issues/156) but on the containerd store of Docker 29.8;
  - `.dockerignore`, which the engine does not apply to an uploaded context.

- **The context impd builds.** impd writes the uploaded tar again as plain ustar, with pax records
  only for long names, and builds that copy. The Dockerfile it checks is the one the engine reads,
  and the lowercase `dockerfile` fallback works as in the frontend. impd refuses a context with two
  entries at one name, a hard link, an entry under a symlink or a file, a device or a FIFO, a name
  that is absolute or holds `..`, or a `security.*` or other xattr that is not `user.*`. It drops
  `user.*` xattrs and sub-second mtimes. The engine applies no ignore file to the uploaded tar, so
  the tar holds exactly the files `COPY .` sees.

**CAUTION:** With `IMP_BUILD_ISOLATION=host`, a `RUN` step runs on the impd host's Docker with the
default bridge network. It can reach the internet and anything the host's bridge can reach, the
host's services on the bridge among them. impd's refusal of a remote `ADD` does not change that.
Isolated builds, the default, close this ([isolated builds](#isolated-builds)).

`--on-host` builds from a directory on the impd host instead, and uploads nothing. The path must be
absolute and must exist where impd runs; `scripts/dev.sh` mounts the repo at its own path for this.
impd packs the directory as the CLI would, `.dockerignore` included, into `<IMP_DATA_DIR>/uploads`,
and refuses a context over `IMP_BUILD_CONTEXT_MAX_MIB` before it sends it. An image you built with
plain `docker build` goes in with `imp image add <ref>` only under `IMP_BUILD_ISOLATION=host`
([add an image](#add-an-image)). `images/dev` and `images/examples/hello` start FROM the published
base by digest; to stack them on another base, edit that FROM line. An imp's own disk can be an
image too: a [template](./templates.md) copies a set-up imp into new ones.

## Isolated builds

By default (`IMP_BUILD_ISOLATION=imp`) each build runs in its own builder imp, which impd destroys
when the build ends. Two separate things hold for a build, and neither stands in for the other:

1. **The input guard** ([#145](https://github.com/zgeoff/imp/issues/145)): impd reads the Dockerfile
   on the host and refuses what the engine would fetch or run on its own, before any builder boots
   (the list above). It rejects inputs; it isolates nothing.
2. **The isolation:** the build runs in a Firecracker VM under the
   [`public` egress policy](../architecture/networking.md#public). A `RUN` step, a pull and the
   frontend's fetch reach the internet only: not the host, impd, other imps, the tailnet, link-local
   or private networks. The firewall does not restrict the builder's own loopback.

A build goes:

1. impd checks the context and the Dockerfile on the host (the guard).
2. It creates a builder imp, `imp-build-<8 letters>`, from the image `imp-builder`
   (`IMP_BUILD_IMAGE`, the published `imp-base` by digest, which impd adds on the first add or
   build), with `IMP_BUILD_MEMORY_MIB` (2048) of memory and `IMP_BUILD_DISK_GIB` (20) of disk. The
   governor and the disk budget admit it as any imp; a refusal fails the build and never falls back
   to the host. Where nft cannot hold the `public` policy, a build fails with `PRECONDITION_FAILED`.
3. It waits for the builder's dockerd (60 s at most), then pulls and pins each image the Dockerfile
   names on the builder's engine, as the host does for a host build. The builder holds no registry
   credentials, so a private image does not pull, and a registry name that resolves to a private
   address fails in the builder's resolver.
4. The pinned context goes in on the builder's stdin to `docker build`. A failed build returns the
   last 8000 characters of its log, `RUN` output included.
5. impd streams `docker export` of the result out of the builder into the same `tar` unpack every
   `imp image add` uses, as root, and computes the image's digest itself: `imp-build-` and a sha256
   over a fixed domain string, the config with its length, and the export, so it never equals a
   Docker image ID or a template's. No host engine reads what the build made, and no Docker tag on
   the host changes. An export fails with `BAD_REQUEST` when its stream, or the disk its entries
   take, is over `IMP_BUILD_IMAGE_MAX_MIB` (8192). The disk counts each entry, as `tar` lists it, at
   its full logical size in whole 4 KiB blocks, so a sparse file or many small files cannot pass a
   small archive off as a small image. An export with more entries than `IMP_BUILD_IMAGE_MAX_FILES`
   (1,000,000) also fails. The directories `tar` makes for a member's missing parents count as
   entries and blocks too. impd ends the export at once when a limit trips or `tar` fails, and after
   120 s in which the builder sends nothing, so a builder that holds its export open still goes. A
   client that goes before the image row is written, or a row that cannot be written, such as a
   template that took the name meanwhile, leaves no row and no rootfs the build made; a rootfs
   another build of the same digest still writes stays.
6. impd destroys the builder, on success, failure or a client that goes. impd destroys a builder it
   finds at start, which a stop cut short. A builder that survives its removal does not fail its
   build, whose image impd wrote: impd logs an `ERROR`, tries again every 30 s until it is gone, and
   `imp ls --builders` shows it meanwhile.

A builder is impd's while it builds: every stream, exec, wake and change but `imp rm` is refused it
with `PRECONDITION_FAILED`, the idle loop and the governor never sleep it, and backups leave it out.
`imp ls` hides builders; `imp ls --builders` shows them, marked `image builder`, and `imps.get`
shows `kind: builder`.

What a build costs on top of a host build: about 1.5 s for the builder and its dockerd, and the
pulls, which start cold in every builder (about 7.5 s for `busybox` and the frontend on a home
link). impd logs each build's phases as `pins=… build=… image=…`.

`IMP_BUILD_ISOLATION=host` builds on the host's engine, as before 0.35.0, for one release only: impd
logs a warning at start and at every build. Use it only when every caller with `manage` is trusted
with the host (the caution above).

The SDK has the same upload:
`client.buildImage(name, context, { dockerfile, size, signal, onProgress })`, where `context` is a
tar as a `Blob`, bytes or a `ReadableStream`. Give a stream's `size` so impd holds only that much
disk; without it, impd holds the whole limit. It reads the answer as a stream and calls `onProgress`
with each progress event; an impd from before the stream answers JSON at the end, and sends no
progress. It throws an `ORPCError` as a contract call would.

## Long calls

A pull, an unpack, an on-host build or a template copy can take longer than a client's fetch waits
for a byte: Bun's fetch gives up after 360 s, Node's (undici) after 300 s. The upload build streams
its answer ([the answer](#build-an-image)); the oRPC calls have streamed twins:

| Procedure            | Same input as  | Phases, in order                        |
| -------------------- | -------------- | --------------------------------------- |
| `images.addStream`   | `images.add`   | `pull`, `unpack`; `copy` for a template |
| `images.buildStream` | `images.build` | `pack`, `build`                         |

Each yields a progress event (`{ type: "progress", phase, elapsedMs }`) as it starts, at each new
phase and every 15 s, then `{ type: "image", image }`. A failure throws its `ORPCError` through the
iterator. oRPC also sends a keepalive comment every 5 s. impd writes the audit row as the work ends,
with its outcome; a refused call is audited at once, as any refused call. `system.info` lists
`imageOpStream` among the features of an impd that has them. `imp image add`,
`imp image build --on-host` and `imp template create` use them when impd does, and show the phase
and its time on a terminal; with an older impd they call `images.add` or `images.build`, which
answer only at the end. The dashboard calls `images.add`.

When the client goes, impd stops what it can:

- an on-host build stops, as an upload build does, and frees its disk room;
- an add stops its pull, but an unpack that has started runs to its end, since another add of the
  same image may wait on it, and the image is added;
- a template copy runs to its end, as it does for `images.add`
  ([templates](./templates.md#making-a-template)).

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
- **`Env`, `WorkingDir`, `User`** from the OCI config. impd writes them to `/etc/imp/image.json`, in
  place of any file the image has there. `/etc` and `/etc/imp` must be directories: an image with a
  symlink or a file at either fails to add or build.

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

Any image boots. Start FROM the published base to get Docker and the usual tools. Copy its FROM line
from `images/dev/Dockerfile`, which names it by digest. `FROM imp/base`, a base you built yourself,
is pinned by its content digest on the containerd image store and refused on the classic store
(#156):

```dockerfile
FROM ghcr.io/zgeoff/imp-base:<tag>@sha256:<digest>
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
