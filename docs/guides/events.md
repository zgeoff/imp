# Events, audit and telemetry

impd reports what happens to imps three ways: a live event stream, an audit log of the calls that
changed something, and OpenTelemetry metrics and spans for a collector you run.

## The event stream

`events.stream` on `/rpc` sends every imp as it is, then each change as it happens. The CLI prints
it as one JSON object a line:

```sh
imp events            # every imp
imp events box        # one imp
imp events | jq -c 'select(.ev == "ImpChanged") | {name: .imp.name, reason, ms: .detail.durationMs}'
```

The SDK returns an async iterator:

```ts
const events = await client.events.stream();

for await (const event of events) {
  console.log(event.ev, event.at);
}
```

The dashboard follows the same stream ([dashboard](./dashboard.md)).

### Events

Every event has `v` (the format version, now `1`), `at` (when impd sent it) and `ev` (its kind). A
reader skips a kind or a field it does not know.

| `ev`                | Fields                                                   | When                                                                                 |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ImpAdded`          | `reason` (`snapshot` or `created`), `imp`                | Each imp as the stream opens, then each new imp.                                     |
| `ImpChanged`        | `reason`, `imp`, `detail` for a timed change             | A change to an imp's record: its state, pid, hold or error.                          |
| `ImpRemoved`        | `imp`, as its record was last                            | `imp rm`: the VM, the disk and the checkpoints are gone.                             |
| `CheckpointAdded`   | `name` (the imp's), `checkpoint`                         | A checkpoint.                                                                        |
| `CheckpointRemoved` | `name`, `checkpoint`                                     | A checkpoint deleted.                                                                |
| `GovernorDecision`  | `decision`, `name`, `trigger`, `usedMib`, `budgetMib`, … | The RAM governor admitted or refused a boot or a wake, or slept an imp to make room. |

`imp` has the shape `imp ls --json` prints, so a reader keeps its own copy with no second call. An
`ImpChanged` reason says why the record changed:

| Reason     | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| `booted`   | A cold boot finished.                                                                    |
| `woke`     | A wake from a memory snapshot finished.                                                  |
| `slept`    | The imp went to sleep: on request, idle, or for the governor (`detail.trigger`).         |
| `stopped`  | The imp stopped, or a new imp is ready without a boot (a fork or a restore from backup). |
| `failed`   | A boot, wake or sleep failed; `imp.error` says why.                                      |
| `repaired` | impd found the VM or the snapshot gone and corrected the record.                         |
| `adopted`  | impd started and found the imp's VM still running.                                       |
| `held`     | A hold was set or cleared.                                                               |
| `restored` | A checkpoint restore finished.                                                           |
| `updated`  | `imp set` changed the imp's CPU limit, weight or vCPUs.                                  |

`detail` comes with `booted`, `woke`, `slept` and `restored`: `durationMs`, `steps` (milliseconds
per step, as impd logs them), `trigger` and, for a boot, `coldBootReason`.

### Guarantees

- impd sends an event after the database write commits, from the one place that writes the imp or
  checkpoint row, so every change reaches the stream, including impd's own repairs. A change to an
  imp's last activity is not an event.
- Events leave in the order the writes landed.
- The stream subscribes before it reads the snapshot, so no change falls between the two. A change
  under way may come in the snapshot and again after it; each event carries the whole imp, so a
  repeat is harmless.
- A reader that falls 1000 events behind is ended, not waited for. A reconnect sends the whole
  snapshot again, so a reader rebuilds its copy from it instead of trusting what it held.
- `imp events` reconnects by itself after impd ends the stream, impd restarts or the network drops:
  after 1 s, then twice as long each time, at most 15 s. It gives up after five ends in a row; a
  stream that lasted 10 s starts the count again. Each reconnect prints the snapshot again and a
  line on stderr.
- `ImpRemoved` comes with no `ImpChanged stopped` before it when the imp was running, and its
  `imp.state` is the last state written. It means the VM, the disk and the checkpoints are all gone;
  no `CheckpointRemoved` comes for them.
- A dashboard stream ends when its session expires and at any logout. The browser reconnects if its
  session is still valid.
- oRPC sends a keep-alive comment every 5 s, so an idle stream stays open through a proxy. Measured
  on 2 October 2026 with two 25 s gaps between events: through the [HTTPS](./https.md) listener,
  each event came 5–14 ms after its change; over the tailnet to impd's API, 73–91 ms. Neither path
  buffered or dropped the stream.

## The API audit log

impd writes one row for each call that changes something: every procedure except the reads, plus
each exec, console, attach and SSH session as it opens, each `imp proxy` tunnel as `tunnel:<port>`,
and each reverse forward as `reverse:<path or port>` (`reverse:auto` for a socket the agent names).
A row has the time, the procedure, the caller, the imp it named, the outcome (`ok` or the error
code) and how long the call took. It never holds the call's input, so a secret's value never reaches
it.

```sh
imp audit --kind api          # every imp, newest first
imp audit box --kind api      # the calls that named box
```

| Caller      | Means                                                      |
| ----------- | ---------------------------------------------------------- |
| `token`     | A call with the API token: the CLI, the SDK, `imp mcp`.    |
| `dashboard` | A call with a dashboard session, or an exec on its ticket. |
| `ssh`       | A session through the [SSH gateway](./ssh.md).             |

impd writes the row after it answers, so the log never slows a call, and a failed write is logged.
It keeps the newest 10,000 rows across all imps. A row names the imp by name with no link to it, so
it outlives `imp rm`.

The broker's log, `imp audit` with no `--kind` (or `--kind broker`), is a different table: the
requests an imp sent with a credential ([connectors](./connectors.md)).

## Telemetry

With `OTEL_EXPORTER_OTLP_ENDPOINT` set, impd starts the OpenTelemetry SDK and sends metrics and
traces over OTLP (HTTP and protobuf). Without it, impd loads no SDK and every instrument does
nothing. The exporters read the standard variables themselves, such as `OTEL_EXPORTER_OTLP_HEADERS`
([configuration](./configuration.md#telemetry)).

| Metric                      | Kind      | Attributes  | Meaning                                     |
| --------------------------- | --------- | ----------- | ------------------------------------------- |
| `imp.lifecycle.transitions` | counter   | `reason`    | Imps created, changed or removed.           |
| `imp.lifecycle.duration`    | histogram | `reason`    | Boot, wake, sleep and restore times, in ms. |
| `imp.governor.decisions`    | counter   | `decision`  | Admissions, refusals and sleeps.            |
| `imp.imps`                  | gauge     | `state`     | Imps in each state.                         |
| `imp.ram.used`              | gauge     |             | RAM the awake imps own, in MiB.             |
| `imp.ram.budget`            | gauge     |             | `IMP_RAM_BUDGET_MIB`.                       |
| `imp.cpu.usage`             | gauge     |             | Cores the running imps used, together.      |
| `imp.cpu.utilization`       | histogram |             | Each running imp's CPU per sample, in %.    |
| `imp.cpu.throttled`         | counter   |             | Time CPU limits held imps back, in s.       |
| `imp.network.io`            | counter   | `direction` | Bytes the guests received and sent.         |
| `imp.awake.time`            | counter   |             | Time imps spent running, in s.              |

The CPU, network and awake metrics come from impd's 5 s sample ([CPU limits](./cpu-limits.md)).
`imp.awake.time` adds up sample intervals, so it misses the boot or wake itself and up to 5 s before
each sleep or stop; `awakeMs` in the API counts the whole span. No metric carries an imp's name, so
the series count stays the same as imps come and go. Each boot, wake, sleep and restore is also a
span (`imp.boot`, `imp.wake`, `imp.sleep`, `imp.restore`) with the imp's name and trigger, and a
child span for each step.
