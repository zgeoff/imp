# dockerfile-difftest

`imp image build` checks a Dockerfile before the build starts. To do that, impd parses it with a
port of the frontend's parser: `packages/daemon/src/images/dockerfile-parse.ts`. The check is sound
only while impd and the frontend split each Dockerfile the same way. This tool tests that: it
generates Dockerfiles full of hostile forms and parses each one twice, with the port and with the Go
parser it ports. The forms cover quotes and escapes, `# escape=`, line continuations, heredocs, a
BOM, CRLF, JSON arrays with escapes, and spaces that are not ASCII.

## When to run it

Run it on every change to `DOCKERFILE_FRONTEND` (the `BUILDKIT_SYNTAX` pin in
`packages/daemon/src/docker-proxy/dockerfile-frontend.ts`) and on every change to
`dockerfile-parse.ts`. CI runs it with one fixed seed in the `checks` job.

## Requirements

- Go, at the version in `go.mod`.
- `go.mod` requires the moby/buildkit commit behind the pinned frontend. For
  `docker/dockerfile:1.19` that is v0.25.0, the commit tagged `dockerfile/1.19.0`. When you change
  the pin, find the commit for the new `dockerfile/<version>` tag, then update `go.mod`:

  ```sh
  cd scripts/dockerfile-difftest
  go get github.com/moby/buildkit@<commit> && go mod tidy
  ```

## Run

```sh
bun scripts/dockerfile-difftest/run.ts            # seed 1, 60000 files
bun scripts/dockerfile-difftest/run.ts --seed 7 --count 200000
```

The tool exits non-zero in two cases:

- **A difference:** both parsers accept a file but read different instructions, flags or words.
- **An unexplained refusal:** Go refuses a file that impd accepts, and the error is not in
  `HARMLESS_GO_ERRORS`. That list holds errors from parsers that impd does not port, such as `ENV`
  pairs. Go fails the build on those errors, so it does not matter that impd accepts them.

When impd refuses a file that Go accepts, the tool prints the case and does not fail. impd fails
closed, as it does for an instruction name that is not ASCII.
