# Sessions

A session is a program on a pty in the guest that outlives its client. A plain exec ends when its
connection does, but a session keeps running when the client goes, and any client may attach to it
again later, from any machine. `imp console` opens one. The agent keeps each session's output in
memory, impd tells a returning client exactly which bytes it missed, and a session started with a
log keeps its output on the host past what the agent holds. The
[session logs guide](../../guides/session-logs.md) covers their use.

## In the guest

The agent runs each session's program on a pty and reads its output on its own, into two buffers,
without ever waiting for a viewer. A history keeps recent raw output for a fresh attach, and a VT
parser reads the output the history drops, so the history knows the terminal modes in effect where
its kept output starts and cuts it between escape sequences. A raw ring keeps exactly the last fixed
span of output, which a resume reads by offset. Each session has a name, and the agent caps the
sessions per imp and the memory each may queue, so the worst case per imp is bounded before the
programs' own memory.

One viewer is attached at a time. A new attach takes the session over, and the viewer before it gets
`detached` with `taken_over`; a viewer that falls too far behind is detached as `slow`. When impd
loses the agent connection without an exit, as at a sleep or a vsock reset, the client gets
`detached` with `lost` and may attach again. An attached session counts as an exec connection and
keeps the imp awake. A detached one holds no connection, and keeps the imp awake only through its
CPU and its TCP connections.

Sessions live in the agent's memory, so they survive a sleep and a wake and end with a cold boot.
`sessions.list` never wakes an imp: impd keeps a copy of each awake imp's sessions from the idle
loop's activity reports, and a sleep writes the last copy into the snapshot's record, so a sleeping
imp lists them too. A stopped imp has none.

## Generations, boots and offsets

A client that reconnects resumes from the exact byte it last saw, and learns what it missed: a gap,
a new process, or no process and the cold boot that ended it. Three identities make that possible.

- **A generation** is one start of a session's process, named by a random ID. A sleep and a wake
  keep it; every cold boot ends it. Offsets count a generation's pty output from zero, and the bytes
  at one offset of one generation never change.
- **A boot ID** names one boot of the guest. A wake keeps it and a cold boot changes it. A guest
  restored from a [boot template](../lifecycle/boot-templates.md) reports a random ID drawn after
  its claim, since every copy of a template shares its kernel's.
- **The cold boots.** impd keeps each imp's last few cold boots with their cause: a start, a wake
  that fell back, the watchdog, a checkpoint restore, or recovery after the VM died. A cause impd
  learns before the boot happens, such as a restore of a stopped imp, waits on the imp's row until
  whichever path boots it next. A move carries the list to the new host.

A resume names a generation and an offset, and its answer says how it was met: `exact`, from that
offset; `gap`, with the bytes the ring no longer holds named as a range; or `generation_changed`,
with the current generation from its first kept byte and whether the old one was replaced in this
boot. An offset past the generation's end is a client bug and fails with `INVALID_RESUME`. A session
with no process answers `NO_SESSION` with the boot ID and the cold boots, so the client finds the
first boot after its own and learns its cause.

Delivery is at least once across connections. A resume can repeat bytes the client has, and the
client drops what is below its high-water mark. No client can recover bytes below the ring's start,
any byte of a generation a cold boot ended, or the output of a plain exec. A client that needs those
keeps what it received, or starts the session with a log.

## Session logs

A logged session keeps its output on the host, in the imp's directory. A log on the imp's own disk
would be readable and writable by the guest's root, would travel with every checkpoint, fork,
template, backup and move, would roll back on a restore and lose its tail on a crash, and would need
a boot to read a stopped imp's output. On the host the log stays out of the guest's reach and out of
every copy of its disk, and reads with no boot.

A session has one viewer, so impd cannot log from the viewer's stream. It taps the session instead:
a tap reads the raw ring by offset beside the viewer, takes no input, never takes the viewer over,
and counts as no connection, so a logged session never keeps an imp awake. impd taps a session when
a start creates it and on every look at the imp's sessions, from the end of its log, and the ring's
answer places the bytes, so a tap that fell behind leaves a recorded hole, never a silent skip. The
agent holds a logged session's output briefly while its ring could drop bytes no tap read, so the
first tap after a start or a wake still finds every byte.

Each generation's log is a set of segment files and a record that lists the length of each that
reached the disk. A crash leaves at most a torn tail, and the reopen cuts each segment back to its
recorded length, so a torn tail never reads back as bytes. Every log has bounds per generation, per
imp and in age, and each new segment asks the [disk budget](../storage/disk-space.md) for room. A
destroy removes the logs with the imp, and a move and a backup leave them behind.

The guest is not trusted here either. Every generation, boot ID and session name an agent reports is
checked against the real agent's form before a tap opens or a file is touched, and each log's
directory must resolve inside the imp's own.
