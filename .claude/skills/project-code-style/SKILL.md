---
name: project-code-style
description:
  imp's additions to the shared code-style skill — its own function verbs and exempt names. Load it
  beside code-style before writing, reviewing, or renaming any TypeScript in this repo.
---

# imp code style

The `code-style` skill holds the rules. imp adds the verbs and exempt names below to its
function-verb taxonomy. Each one also sits in the `verbs` or `exemptNames` option of
`zgeoff/function-verb` in [`.oxlintrc.json`](../../../.oxlintrc.json); add a new one to both in the
same PR, because `check-project-verbs.sh` fails when the lists differ.

## Project verbs

imp's verbs name the lifecycle an imp moves through, its disk, which only grows, and its elastic
memory, which also shrinks. `watch` follows impd's event stream and calls back on each change until
a signal ends it, opening the stream again when it drops. `dispatch` runs the handler that the first
word of a command line names, for a command whose verbs share its arguments.

- `allocate`
- `list`
- `open`
- `sleep`
- `wake`
- `hold`
- `grow`
- `shrink`
- `watch`
- `dispatch`

## Exempt names

- `main`, a script entrypoint
- `invariant`, the narrowing helper the testing skill names
- `init`, the first of the methods kysely's `Driver` interface fixes, which `BunSqliteDriver`
  implements under the names the library requires
- `acquireConnection`
- `beginTransaction`
- `commitTransaction`
- `rollbackTransaction`
- `releaseConnection`
- `destroy`
- `up`, the method kysely's `Migration` interface fixes
