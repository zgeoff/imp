# Preloads, shared test utils and cleanup

Two preloads own the shared state of a test process: the
[root preload](../../../../packages/test-utils/src/preload.ts) serves every package but the
dashboard, and the dashboard has [its own](../../../../packages/dashboard/test-setup.ts). Helpers
that every package uses live in [the shared test utils](../../../../packages/test-utils/src/), and
each package keeps its own stand-ins in its `test-utils` folder. Read a helper's own test before you
rely on it, because that test pins what the helper does.

## The root preload

The root preload gives each unit test a clean impd environment. It deletes every `IMP_*` variable
the shell passed in, except the run gates, so a developer's own settings never reach a test. A test
that needs an impd setting sets it through
[`updateEnv`](../../../../packages/test-utils/src/update-env.ts) before it calls `setupTest()`, and
the test's impd then reads it through
[`readImpEnv`](../../../../packages/test-utils/src/read-imp-env.ts), as production does.

The end-to-end suites run under a preload of their own, with no MSW server, because each journey
talks to a real dev instance over the network.

The shared test utils hold the condition wait
[`waitFor`](../../../../packages/test-utils/src/wait-for.ts) and the scripted answer queue
[`buildStubAnswerQueue`](../../../../packages/test-utils/src/build-stub-answer-queue.ts). The queue
hands out a dependency's answers in order and throws on a call past the last one, so a test that
expects three calls fails on a fourth.

## The dashboard's preload

Dashboard component tests run the real SDK against a mock impd that MSW serves at a fake origin. The
mock router reuses impd's own access checks, API errors and lifecycle rules from the daemon package,
so a dashboard test sees the answers that impd gives. Where a daemon module would pull Bun-only
types into the dashboard's DOM typecheck, the mock holds a copy of the function with a comment that
explains why.

The mock keeps its rows in in-memory collections, which the preload empties after each test. One row
stands for the browser's session cookie, because Bun's fetch keeps no cookies, and each call reads
the session's token again. A changed token therefore takes effect at once, and a deleted one logs
nobody in. A procedure that the mock router leaves out returns impd's `not found`, so add the
procedure to the router when the dashboard starts to call it.

To write a test, log in through
[`createDashboardSession`](../../../../packages/dashboard/src/test-utils/create-dashboard-session.ts),
mount the whole app through
[`renderApp`](../../../../packages/dashboard/src/test-utils/render-app.tsx), and add a per-test MSW
handler when the test reads a call's input.
[The dashboard's test utils](../../../../packages/dashboard/src/test-utils/) and
[mocks](../../../../packages/dashboard/src/mocks/) hold them.

## Cleanup order

`onTestFinished` runs callbacks in the order of registration, so the cleanup order follows from
which kind of util a test calls:

- **A util that registers its own cleanup** releases its resource before anything that the test
  registers after the call. The guest agent stand-ins, the SSH and DNS stand-ins, the Firecracker
  stand-ins, the test databases, the port picker and the in-memory metrics are this kind. A stub
  agent also accepts a stack, and then defers its close into that stack instead.
- **A util whose first parameter is a stack** registers nothing itself. The governed-imps harness,
  the move hosts, the broker's network stand-ins, the echo servers and the ZFS test dataset are this
  kind. The test creates the stack and registers its disposal on the next line. Anything that must
  release first, such as a held template build step, defers into the same stack after the util's
  call.

## What a setupTest returns

A daemon test file's `setupTest()` seeds the image that every imp create boots. A test that asserts
on that image reads it from `setupTest()` as `ctx.image` instead of naming it again.

To test behaviour that spans a whole test process, such as a preload, run the test file in a child
`bun test` through [`runChildTests`](../../../../packages/test-utils/src/run-child-tests.ts). The
runner gives the child its own working directory and kills it at a timeout.
