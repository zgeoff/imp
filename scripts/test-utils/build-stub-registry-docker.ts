// What the registry answers for the tag: it has none, it has one (the inspect's stdout,
// such as a digest), or the inspect fails with `error` on stderr
type StubRegistryAnswer =
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly error: string };

function buildShellWord(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

// A stub docker's script, for createStubBin, that answers `docker buildx imagetools inspect
// <ref> ...` as the registry would for the release workflow's Plan step. A missing tag fails
// with buildx's `ERROR: <ref>: not found`; any other call fails as unexpected.
export function buildStubRegistryDocker(answer: StubRegistryAnswer): string {
  const answers = {
    missing: 'echo "ERROR: $4: not found" >&2; exit 1',
    found: answer.kind === 'found' ? `printf '%s\\n' ${buildShellWord(answer.stdout)}` : '',
    failed:
      answer.kind === 'failed' ? `printf '%s\\n' ${buildShellWord(answer.error)} >&2; exit 1` : '',
  };

  return `case "$1 $2 $3" in
  "buildx imagetools inspect") ${answers[answer.kind]} ;;
  *) exit 1 ;;
esac`;
}
