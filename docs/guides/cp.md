# Copying files: `imp cp`

`imp cp` copies a file or a directory into an imp or out of one. One side is a path on this machine;
the other is `NAME:PATH` in an imp.

```sh
imp cp ./app box:/srv          # makes /srv/app in the imp
imp cp ./app box:/srv/site     # makes /srv/site, when it is not a directory yet
imp cp box:/var/log/app.log .  # makes ./app.log
imp cp --owner www-data ./site box:/var/www
```

The rules follow `cp -r`. When the target is a directory, the copy goes into it under its own name;
otherwise the copy takes the target's name. A path in the imp that is not absolute is relative to
the home of the image's USER, as with `scp`: `box:work` is `/home/dev/work` for a `dev` image. A
local path with a colon in its first part starts with `./`.

A copy wakes a sleeping imp. On a terminal, stderr shows the bytes copied and the percent of the
total. The command exits 0 when everything was copied, 1 when anything was not, and 2 for a usage
error.

## What a copy keeps

- **Files and directories:** their permission bits and modification times. Setuid and setgid are
  dropped on both sides; the sticky bit stays.
- **Symlinks:** copied as symlinks, never followed.
- **Hard links:** a copy out of the imp makes each linked name its own file. A hard link in an
  archive is made only when it points to a file of the same copy.
- **Sockets, devices and FIFOs:** left out, with a warning.
- **Sparse files:** copied whole; the holes become zeros.
- **Owner:** what a copy into the imp makes belongs to the image's USER, or to `--owner` (`user`,
  `uid`, `user:group` or `uid:gid`). A directory that was there already keeps its owner and mode. A
  copy out of the imp belongs to you.

## How it works

The guest side is `imp-agent tar` on the system drive, so every image has it. impd runs it as root
(an exec `tool`, [daemon](../architecture/daemon.md#exec-the-exec-bridge)), so a copy reaches paths
the image's USER cannot. It needs the agent from protocol `0.7.0`; an older imp answers with
`AGENT_OUTDATED`: stop and start it to update it ([operations](./operations.md#upgrade)).

The archive is a tar stream over the exec. Its first entry carries a PAX record, `IMP.total`, with
the bytes of every file, so a copy out of the imp shows a percent. impd acks the upload's bytes once
they are on their way to the guest, and the CLI keeps at most 1 MiB unacked, so a large upload to a
slow disk cannot grow impd's memory.

## Safety

Each side extracts an archive from the other, and neither trusts it. Both apply these rules, in
order:

1. A name that is absolute, holds `..`, or does not start with the copy's top is refused.
2. An entry whose parent path holds a symlink is refused.
3. A file is written to a fresh temp name (`O_EXCL`), then renamed over its place.
4. A hard link must point to a file of the copy.
5. Devices and FIFOs are skipped, and setuid and setgid are dropped.
6. Symlinks are made last, so no entry is written through one; directory modes are set after
   everything, so a read-only directory can still be filled.

In the imp, the extract runs as root while guest processes run beside it, so rule 2 has to hold even
when a process swaps a directory for a symlink mid-copy. Every lookup goes through `openat2` with
`RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS` from the directory the copy lands in, so the check and the
write are one step. On this machine nothing races the extract, so it checks with `lstat` instead. A
refused entry is reported, the rest still copies, and the command exits 1.
