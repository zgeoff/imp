# Templates

A template is an image made from an imp's disk. Set up one imp the way you want it (packages,
config, a warm build cache), make a template of it, and create imps from the template. Each new imp
starts with a copy of that disk.

```sh
imp new --name golden
imp exec golden -- apt-get install -y build-essential
imp template create golden builder      # the image `builder`, from golden's disk
imp new --name job1 --image builder
imp new --name job2 --image builder
```

`imp template` is a shortcut for the images API with an imp as the source. It has no routes of its
own: `imp template create <imp> <name>` calls `images.add` with `{ imp, name }`, `imp template ls`
lists the images whose `source` is `imp`, and `imp template rm` calls `images.delete`. A template is
an image in every other way: `imp image ls` lists it, `imp new --image` takes it, and the RAM, disk
and egress settings of a new imp come from the create call, not from the source imp.

## Making a template

impd copies the disk the same way as a checkpoint
([storage](../architecture/storage.md#checkpoints-restores-and-forks)):

- A running imp is frozen (`sync` and `FIFREEZE` in the guest) for the time of the clone, then
  thawed.
- A sleeping imp wakes first, because its memory holds page cache that is not on the disk yet. It
  stays awake after.
- A stopped imp is copied as it is.

The copy is a reflink clone on XFS and a ZFS clone on ZFS, so a template costs no space until the
source or the template's imps write to their disks. The source imp keeps running, and later changes
to it do not change the template.

`imp template create` with a name that is a template already makes the template again from the imp's
disk now. The name then points at the new copy. Imps made before keep their own disks. The old copy
is removed once no image names it. A template and a docker image never share a name: impd refuses
`imp template create` over a docker image and `imp image add` over a template.

`imp template rm` refuses a template that an imp still uses, as `imp image rm` does for any image.

`imp template create` reads `images.addStream` from an impd that has it, and shows how long the copy
takes ([long calls](./images.md#long-calls)). A copy runs to its end when the client goes, and the
template is made.

## Disk size

An imp from a template gets at least the template's disk, which is the size of the source imp's disk
when the template was made. `--disk` below that size fails:

```text
a disk of 4096 MiB is smaller than template builder's disk (8192 MiB)
```

Without `--disk`, the new disk is the larger of `IMP_DEFAULT_DISK_GIB` and the template's disk.

## Identity

The template holds what the source imp had on its disk, including the files that make a machine
unique. On the first boot of an imp made from a template, impd adds `imp.reset_identity=1` to the
kernel command line. Before any service starts, the agent then:

- writes a new random `/etc/machine-id`, and the same ID to `/var/lib/dbus/machine-id` when that is
  a file of its own (a link to `/etc/machine-id` follows it). An empty or missing `/etc/machine-id`
  stays as it is: the template holds no ID to share.
- makes new host keys with `ssh-keygen -A` in a directory beside `/etc/ssh`, then renames each one
  over the old key and deletes any old `ssh_host_*` key of a type it did not make. A keygen that
  fails or takes more than 30 s leaves the old keys, so sshd still starts. An image without
  `ssh-keygen` keeps its keys.
- syncs the disk, and reports `ok` or `failed` in its `ping`.

The hostname and `/etc/hosts` are set from the imp's name on every boot already. impd clears the
flag only when a boot reports `ok`, so a failed reset or a boot that fails runs the reset again on
the next boot, and later boots keep the new identity. A fork, and a restore from a backup, carry the
flag: a fork of a copy that has not reset yet resets on its own first boot, as the copy would.

A reset that fails on every boot, such as an `ssh-keygen` that ignores `-f` with `-A`, writes a new
machine-id on each cold boot while the old host keys stay; impd logs each attempt.

## Access

A template holds its source imp's disk. A token limited to some imps may create an imp from a
template only when its patterns reach the template's source imp, as a fork needs the source. The
images row keeps the source imp's name for this check, and the `images.add` or `images.addStream`
audit row names it.

Other per-machine state in the disk is copied as it is: application secrets, tokens in home
directories, a `/var/lib/systemd/random-seed`, and any IDs your own software stores. Remove them
from the source before you make the template, or reset them in a service at boot.

## How a template is stored

A template is a row in the `images` table with `source` = `imp`. Its digest is `imp-<uuidv7>`, a
name no docker image ID can have, so impd never runs docker for it. Its directory is
`images/imp-<uuidv7>/` with `rootfs.ext4` (the clone) and `config.json` (the source image's docker
config).

On ZFS the template's dataset is a clone of the source's disk, and the template's imps are clones of
the template's `@base`. Each one can go in any order: the source, the template or its imps. The
[reclaim](../architecture/storage.md#reclaim) promotes the next clone and frees the blocks once the
last user is gone.

[Backups](../architecture/backups.md) carry every image, templates included. A restore brings back
each imp's image before the imp. A restore of all imps also brings back every template, even one
that no imp uses, because a template cannot be pulled again from a registry.
