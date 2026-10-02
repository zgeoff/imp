# @zgeoff/imp-client

A typed client for [impd](https://github.com/zgeoff/imp), the imp host daemon. It runs in a browser,
in Bun and in Node 22 or later.

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

## Errors

A failed call throws an `ORPCError`. impd's errors carry a `code` and typed `data`:

| Code                  | When                                                 | `data`                                 |
| --------------------- | ---------------------------------------------------- | -------------------------------------- |
| `NOT_FOUND`           | No imp, image or checkpoint has that name.           | `{ kind, name }`                       |
| `CONFLICT`            | The name is taken.                                   | `{ kind, name }`                       |
| `INVALID_STATE`       | The imp's state does not allow the call.             | `{ state, allowed }`                   |
| `RAM_BUDGET_EXCEEDED` | The host has no room, even after sleeping idle imps. | `{ budgetMib, usedMib, requestedMib }` |
| `SERVICE_UNAVAILABLE` | impd is stopping.                                    |                                        |
| `FORBIDDEN`           | An exec ticket was used for another imp.             |                                        |

```ts
import { isDefinedError, safe } from '@zgeoff/imp-client';

const [error, created] = await safe(imp.imps.create({ name: 'dev' }));

if (isDefinedError(error) && error.code === 'RAM_BUDGET_EXCEEDED') {
  console.log(`needs ${error.data.requestedMib} MiB`);
}
```

A 401 means the token is wrong.

## Versions

The client and impd are released together with the same version. `imp.checkServer()` tells whether
impd speaks this client's API: the major version must match, and before 1.0 the minor version too.

```ts
const check = await imp.checkServer();

if (!check.compatible) {
  throw new Error(`impd ${check.serverVersion} does not match client ${check.clientVersion}`);
}
```
