# Preloads, shared test utils and cleanup

## The dashboard's preload

The root `bunfig.toml`'s `pathIgnorePatterns` skips `packages/dashboard/**`, so the dashboard's
tests run from the package. Its `bunfig.toml` preloads `@zgeoff/bun-test-extended`,
`@zgeoff/bun-test-react` (happy-dom, the jest-dom matchers, and an unmount after each test), then
`packages/dashboard/test-setup.ts`. That preload runs the shared run hooks (a seeded faker and env
restores), sets the page's URL to `http://impd.test/ui/`, wraps `fetch` so a request to that origin
carries `Sec-Fetch-Site: same-origin` as a browser's does
(`src/test-utils/build-stub-browser-fetch.ts`), restores spies and mocks after each test, and runs
the dashboard's own MSW server (`src/mocks/node.ts`). Its handlers (`src/mocks/handlers.ts`) answer
impd's `/auth/login`, `/auth/logout` and `/rpc/*` at `http://impd.test`, so the real SDK's fetch
reaches them. `/rpc/*` runs oRPC's own fetch handler over `src/mocks/impd-router.ts`, an
`implement(impContract)` router of the procedures the dashboard calls. It reuses impd's own code
from `packages/daemon`: `checkAccess` and the builder check on every call, the errors of
`api-errors.ts`, `requireTransition` for lifecycle moves, `resolveCpuSettings`, `deriveImageName`,
the ssh key parser, `isSameOrigin`, `toLeaseSummary`, `createLogouts` and `openEventStream`. A few
small functions are copied with a comment instead, because their modules pull Bun-only types into
the dashboard's DOM typecheck or are not exported. A procedure it leaves out answers impd's
`not found` 404. The router reads and writes the `@msw/data` collections in `src/mocks/db/` (imps,
checkpoints, images, tokens with their secrets, sessions, secrets, imp policies, and the host, whose
default row the first read keeps; `system.info` derives its counts from the imp rows), which the
preload empties after each test with `resetMockDb`. Lists come back in impd's order: imps and tokens
by name, checkpoints newest first. A row in the sessions collection stands for the one browser's
session cookie, which Bun's fetch does not keep. It holds the token's id, as impd's `tokenId`, and
each call re-reads that token, so a changed token takes effect at once and a deleted one, even if a
new token takes its name, logs nobody in. A call gets impd's 401 without a session, after its
`expiresAt`, once its token is gone, or from another origin. Login with a token's secret replaces
the session; logout clears it and ends every open event stream. A test logs in with
`createDashboardSession` (`src/test-utils/create-dashboard-session.ts`). Lifecycle calls emit impd's
events; `emitImpdEvent` sends one for a change made elsewhere, each stream passes only the events of
the session's imps, and the preload clears `impdEventListeners`. `src/test-utils/render-app.tsx`
(`renderApp`) mounts the whole app with the production `createBrowserImpd`, and `read-rpc-input.ts`
reads a call's input in a per-test MSW handler.

## The root preload

The root preload is `packages/test-utils/src/preload.ts`, ahead of `@zgeoff/bun-test-extended`;
`packages/test-utils/bunfig.toml` repeats it for a run from that package. At load it removes every
`IMP_*` variable the shell passed in (`remove-ambient-imp-env.ts`), except the run gates
`IMP_HOST_TESTS`, `IMP_TEST_SMALL_FS`, `IMP_TEST_ZFS_ROOT` and `IMP_TEST_ZFS_DIR`, so no developer
setting reaches a unit test; a test sets an impd setting with `updateEnv` before its `setupTest()`,
which passes `readImpEnv()` (`read-imp-env.ts`, the `IMP_*` variables only) to `loadConfig` after
its fixed boot values. It seeds faker, restores every `updateEnv` override after each test,
registers the run's one tracer provider (`register-tracing.ts`: a `BasicTracerProvider` over
`spanExporter`, an `InMemorySpanExporter` that a test reads and the preload resets after each test),
and runs one MSW server (`packages/test-utils/src/mock-server.ts`) for the whole run with
`onUnhandledRequest: 'error'`. The server intercepts `fetch` only; `node:http` clients and
WebSockets stay native. While it listens, the global `fetch` sends a request to a loopback host or
over a unix socket to the native fetch (`route-fetch.ts`), and every other request to MSW. The
end-to-end suites run with `e2e/bunfig.toml`, whose preload (`preload-e2e.ts`) restores env
overrides and seeds faker, with no MSW server. `updateEnv`, `invariant` and `waitFor` live in
`packages/test-utils/src`, with `buildStubAnswerQueue`, which hands out a dependency's scripted
answers in order and throws on a call past the last one.

## Cleanup order

`onTestFinished` runs callbacks in registration order (see SKILL.md), so a util that registers its
own cleanup is released before anything the test registers after calling it. These utils register
their own: `startStubAgent` (its `close` may also run earlier; given `{ stack }`, it defers the
close there instead), `startStubExecAgent`, `startStubSessionAgent`, `startStubAttachAgent`,
`startStubServiceAgent`, `startStubDialAgent` and `startStubEchoExecAgent` (through
`startStubAgent`, so each also takes `{ stack }`), `startStubDnsUpstream`, `createTestDatabase`,
`createUnmigratedDatabase` (it closes the SQLite handle itself, since Kysely closes a driver only
after a query started it), `buildQueryGate` (it releases a held select), `findFreePorts` (it
releases its port claims), `startInMemoryMetrics` (it unregisters its meter provider, and throws
when another is registered), `startStubSshAgent`, `startStubSshServer` (it stops listening and
leaves each open connection to its client's own end), `openSshClient` (it ends the client),
`startStubSilentTcpProxy`, `setupMoveHosts`, `startStubFirecrackerApi`,
`startStubFirecrackerProcess`, `startStubFirecracker`, `startStubGithubReleases` and the client's
`createStubUndiciWebSocket` (it closes the socket).

Utils that take a caller's stack and register nothing themselves:

- `createImpTest(stack, options)` in `imps/test-imps.ts`: the governed-imps harness. A test creates
  the stack and registers its disposal on the next line; the client smoke's `run-stub-impd.ts`
  disposes it at exit. For each impd it starts, the stack stops its boot templates, which waits for
  a running template build, before it removes the data dir. It releases the fake's hangs first, and
  stops waiting for a replaced impd's build once its VM call parks (`whenTemplateBuildParks`); a
  build past that call still finishes. A test that holds the `template` step defers the release into
  the same stack, so the release runs first.
- `createMoveHosts(stack, options)` in `moves/test-moves.ts`: the two `setupMoveHosts` impds.
- The broker stand-ins `test-utils/start-stub-broker-*.ts` that start something: the TLS and plain
  upstreams, the reply and hold targets, the guest socket and the tunnel.
- `runWithStack(body)` in `test-utils/run-with-stack.ts`: runs `body` with a fresh stack and
  releases it once `body` settles or throws.
- `startStubEchoServer(stack)` in `test-utils/start-stub-echo-server.ts`: a tunnel's far end on
  loopback.
- `createZfsTestDataset(stack, options)` in `test-utils/create-zfs-test-dataset.ts`: a real-pool
  test's own dataset (see [ZFS](./zfs-nixos-go-ci.md#zfs)).
- `startStubHeaderEcho(stack)` in `test-utils/start-stub-header-echo.ts`: an imp or impd's API
  behind the HTTPS listeners, which answers with the headers it got and echoes WebSocket messages.

## What a setupTest returns

A daemon test file's `setupTest()` seeds the image that every imp create boots. A test that asserts
on the image takes it from `setupTest()` as `ctx.image`, as `reset-baseline.test.ts` and
`packages/mcp/src/tools/imp-tools.test.ts` do.

The `setupTest()` of `vmm/jail.test.ts` and of `vmm/vm-runner.test.ts` returns `createImpDir`, a
closure that makes a per-test imp directory under the test's temp root from a name the test passes.
The closure only composes the production path helpers with `mkdirSync`, so it holds no logic that
could fail without a test of its own.

The `setupTest()` of `storage/zfs/zfs-backend.test.ts` builds the fake pool's backends and returns
`createPoolBackend`, which the real-pool tests call: it makes the test's own dataset on the real
pool with `createZfsTestDataset` and returns a backend on it, with a `startBackend` for a new impd
on the same dataset.

`packages/daemon/src/create-impd.test.ts` returns its stack as `ctx.stack`.
`packages/test-utils/src/run-child-tests.ts` (`runChildTests(dir, source, timeoutMs = 4000)`) runs
one test file in a child `bun test` with `dir` as its working and temp dir, and kills it at
`timeoutMs`.
