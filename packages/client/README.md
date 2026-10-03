# @zgeoff/imp-client

A typed client for [impd](https://github.com/zgeoff/imp), the imp host daemon. It runs in Bun, in
binaries that `bun build --compile` makes, in Node 22.6 or later, and in browsers with
`Promise.withResolvers`: Chrome 119, Firefox 121 and Safari 17.4 or later. CI checks each release
under Node, Bun and a compiled Bun binary.

```sh
npm install @zgeoff/imp-client
```

`@opentelemetry/api` is an optional peer: oRPC's type declarations name it, so a project that
type-checks its dependencies (no `skipLibCheck`) installs it too.

## Connect

```ts
import { createImpClient } from '@zgeoff/imp-client';

const imp = createImpClient({
  url: 'http://localhost:7070',
  token: process.env.IMP_TOKEN,
});
```

- `url` is impd's API. A path prefix is kept, so impd can sit behind a proxy at `/impd/`.
- `token` is the bearer token from `<IMP_DATA_DIR>/token`. It controls every imp on the host, so
  keep it on a server. A browser app sends its requests through a proxy that adds the token, and
  leaves `token` out.
- `fetch` swaps the transport, for example to call an in-process app in tests.

## Imps, checkpoints and forks

Every procedure of impd's API is on the client, with its input and output types.

```ts
const dev = await imp.imps.create({ name: 'dev', memoryMib: 2048 });

const checkpoint = await imp.checkpoints.create({ name: 'dev', label: 'clean' });

// a new imp from the checkpoint's disk
await imp.imps.fork({ source: 'dev', name: 'dev-2', checkpoint: checkpoint.id });

await imp.imps.sleep({ name: 'dev' });
```

`imp.requireAwake(name)` makes one wake call. It wakes a sleeping imp, boots a stopped one and
returns a running one as it is. impd refuses an imp in the `error` state with `INVALID_STATE`,
because a wake would restart it; pass `{ restartError: true }` to restart it anyway. While impd
stops, calls fail with `SERVICE_UNAVAILABLE`, and while it restarts, `fetch` cannot connect; pass
`{ retryUnavailable: { attempts, delayMs } }` to wait for it to come back. `RAM_BUDGET_EXCEEDED` is
never retried.

## Run commands

`imp.run` runs a command to its exit and collects its output. Without `stdin`, stdin closes at once.

```ts
const result = await imp.run('dev', ['sh', '-c', 'uname -a; cat'], { stdin: 'hi\n' });

console.log(result.code, new TextDecoder().decode(result.stdout));
```

`imp.openExec` streams instead. `stdout` and `stderr` are `ReadableStream`s that end with the
session. `write` takes a string or bytes and waits while the socket's buffer is full, so a writer in
a loop keeps to the network's pace.

Read or cancel both streams. Output nobody reads waits in memory, and past 8 MiB on one stream
(`maxUnreadBytes`) the session ends with `OUTPUT_OVERFLOW`. Cancelling both streams ends the session
and stops the command; so do `close()` and the `signal` option's abort.

```ts
const tail = await imp.openExec('dev', ['tail', '-f', '/var/log/app.log']);

void tail.stderr.cancel();

try {
  for await (const chunk of tail.stdout) {
    if (process.stdout.write(chunk) === false) {
      break;
    }
  }
} finally {
  tail.close();
}
```

`imp.openConsole` opens a login shell with a tty, the shell of the image's user, as `imp console`
does. With [xterm.js](https://xtermjs.org):

```ts
const shell = await imp.openConsole('dev', { cols: term.cols, rows: term.rows });

term.onData((data) => {
  shell.write(data).catch(() => {});
});
term.onResize(({ cols, rows }) => shell.resize(cols, rows));

const reader = shell.stdout.getReader();

for (let read = await reader.read(); !read.done; read = await reader.read()) {
  term.write(read.value);
}
```

With `session: 'main'`, `openConsole` and `openExec` start that session, or attach to it if it runs,
and the shell outlives the handle: `close()` detaches.
`imp.openAttach('dev', 'main', { cols, rows })` attaches to a running session; its `stdout` starts
with a replay of the recent output. `sessions.list` names them without waking the imp. `started`
resolves with `{ pid, session, created, groupKill, output }`. When impd ends the socket while the
session runs on, `exit` rejects with `DETACHED`, and its `data.reason` says why: `taken_over`
(another client attached; one is attached at a time), `slow` (the client fell too far behind) or
`lost` (impd lost the guest, as when the imp slept; attach again).

### Resuming a session

`started.output` places the data in the session's output. With `continuity: 'offsets'` it has the
generation (`executionGeneration`, one run of the process), the `bootId`, `bufferStart` and `end`,
and `offset`, the offset of the first data byte after `prelude` mode bytes; `{ continuity: 'none' }`
means an imp whose agent predates offsets, or an older impd. `exit` resolves with `offset`, and
`DETACHED` has `data.offset`: the offset after the last byte received. Keep the generation and that
offset, and resume from them:

```ts
const tail = await imp.openAttach('dev', 'main', {
  resumeFrom: { executionGeneration, offset },
  wake: false,
});

const { output } = await tail.started;
```

`output.resume` says how the resume was met: `exact`; `gap`, whose bytes `[from, to)` are gone (a
terminal should attach again without `resumeFrom`, since the data can start inside an escape
sequence); or `generation_changed`, a new process, whose data starts at `firstOffset`. A resume can
repeat bytes you have: drop those below your high-water mark. `output.coldBoots` lists the imp's
last cold boots, newest first, with a `cause` (`start`, `wake_fallback`, `watchdog`, `restore`,
`recovery`, `unknown`); the first one after your `bootId` ended your generation. `wake: false`
rejects with `InvalidStateError` instead of booting or waking the imp.

A disconnected client cannot recover bytes below `bufferStart`, any byte of a generation that a cold
boot ended, or the output of an exec without `session`. Keep what you received if you need them.
`system.info()` has `features.sessionOffsets` on an impd that carries offsets.

With a tty, `sendSignal('SIGINT')` and `sendSignal('SIGQUIT')` send ^C and ^\ as keys, so they reach
the foreground job; other signals, and every signal without a tty, go to the process. A write after
the session ended rejects with `CLOSED`.

The socket authenticates with a single-use exec ticket from `exec.ticket`, so the token never goes
in a URL; a browser behind a proxy that adds the token works the same way.

`exit` resolves with `{ code, signal }`, where `code` is null when a signal ended the command. When
the command did not run to its exit, `exit` rejects with an `ExecError` whose `code` is impd's (as
in the table below, plus `EXEC_FAILED` when the command cannot start and `INNER_DOWN` when the imp's
container is down) or one of `UNAUTHORIZED` (also for an exec ticket that expired or was used),
`UNREACHABLE`, `RESTARTING`, `CONNECTION_CLOSED`, `DETACHED`, `BAD_MESSAGE`, `CLOSED`,
`OUTPUT_OVERFLOW` and `LOCAL_ERROR`. Its `data` is impd's error data. Three codes reject as their
own subclasses, with typed `data`: `NoSessionError` (`NO_SESSION`:
`{ bootId, coldBoots, previous? }`, or no data from an agent without offsets), `InvalidStateError`
(`INVALID_STATE`: `{ state, allowed, coldBoots? }`) and `InvalidResumeError` (`INVALID_RESUME`:
`{ end, bufferStart }`, a resume past the end). An abort before the command starts, during the
ticket call or the connect, rejects with the abort's reason instead, an `AbortError` by default;
after the start it ends the session as `CLOSED`.

## Errors

A failed call throws an `ORPCError`. impd's errors carry a `code` and typed `data`:

| Code                  | When                                                 | `data`                                 |
| --------------------- | ---------------------------------------------------- | -------------------------------------- |
| `NOT_FOUND`           | No imp, image, checkpoint or session has that name.  | `{ kind, name }`                       |
| `CONFLICT`            | The name is taken.                                   | `{ kind, name }`                       |
| `INVALID_STATE`       | The imp's state does not allow the call.             | `{ state, allowed, coldBoots? }`       |
| `RAM_BUDGET_EXCEEDED` | The host has no room, even after sleeping idle imps. | `{ budgetMib, usedMib, requestedMib }` |
| `SERVICE_UNAVAILABLE` | impd is stopping.                                    |                                        |
| `FORBIDDEN`           | An exec ticket was used for another imp.             |                                        |
| `AGENT_OUTDATED`      | The imp's agent has no sessions; stop and start it.  |                                        |

```ts
import { isDefinedError, safe } from '@zgeoff/imp-client';

const [error, created] = await safe(imp.imps.create({ name: 'dev' }));

if (isDefinedError(error) && error.code === 'RAM_BUDGET_EXCEEDED') {
  console.log(`needs ${error.data.requestedMib} MiB`);
}
```

A 401 means the token is wrong.

## Features

An older impd drops an input field it does not know, and the call succeeds without it. Check
`system.info().features` before you send a field that a later impd added:

| Field                                 | Feature           | Since  |
| ------------------------------------- | ----------------- | ------ |
| `grantable` on `tokens.create`        | `grantableTokens` | 0.27.0 |
| `rebind` on `secrets.add` (`replace`) | `secretRebind`    | 0.27.0 |
| `require` on `openExec`               | `execRequire`     | 0.30.0 |

```ts
const info = await imp.system.info();

if (info.features?.grantableTokens !== true) {
  throw new Error('this impd makes tokens without a grantable list');
}
```

Without the `secretRebind` feature, a `replace` that changes the hosts keeps every grant. With it,
it fails with `CONFLICT` and `data.reason: 'binding_changed'` unless `rebind` is set.

`openExec` and `openExecSession` check `execRequire` themselves when `require` is set. With
`require: ['broker']`, the command starts only once impd set the credential broker's variables and
CA bundle for this boot; otherwise the exec fails with `PRECONDITION_FAILED` and
`data: { reason: 'broker_not_ready', detail }`, and nothing runs. Without the feature it fails the
same way with `reason: 'impd_outdated'` before it sends the start. See
[requiring the broker](https://github.com/zgeoff/imp/blob/main/docs/guides/connectors.md#requiring-the-broker).

## Versions

The client and impd are released together with the same version. `imp.checkServer()` tells whether
impd speaks this client's API: the major version must match, and before 1.0 the minor version too.

```ts
const check = await imp.checkServer();

if (!check.compatible) {
  throw new Error(`impd ${check.serverVersion} does not match client ${check.clientVersion}`);
}
```
