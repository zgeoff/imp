// Writes stdin to "$1", through a symlink, by a temp file and a rename, so no
// reader sees half a file. An existing file keeps its mode, a new one gets
// 0666 less the umask. Each command works in coreutils and BusyBox alike.
export const WRITE_SCRIPT = [
  'set -e',

  // any exit before the content is read still reads it: the writer must not
  // meet a closed pipe, whose EPIPE would hide this exit and its message
  "trap 'cat >/dev/null' EXIT",
  'target=$1',
  'if [ -L "$target" ]; then',
  '  target=$(readlink -f "$target") || { echo "cannot resolve the symlink $1" >&2; exit 1; }',
  'fi',
  'if [ -d "$target" ]; then echo "$1 is a directory" >&2; exit 1; fi',
  'dir=$(dirname "$target")',
  'mkdir -p "$dir"',
  'tmp=$(mktemp "$dir/.imp-write.XXXXXX")',
  'trap \'rm -f "$tmp"; cat >/dev/null\' EXIT',
  'cat > "$tmp"',
  'if [ -e "$target" ]; then mode=$(stat -c %a "$target"); else mode=$(printf %o $((0666 & ~$(umask)))); fi',
  'chmod "$mode" "$tmp"',
  'mv -f "$tmp" "$target"',
  'trap - EXIT',
].join('\n');
