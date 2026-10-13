// What `imp-agent tar` takes after "tar" (agent/internal/tartool): a tar of
// the guest path on stdout, or stdin's tar extracted into it, owned by
// `owner` when given.
export type TarCommand =
  | { readonly op: 'create'; readonly path: string }
  | { readonly op: 'extract'; readonly path: string; readonly owner?: string | undefined };

export function buildTarArgs(command: TarCommand): string[] {
  if (command.op === 'create') {
    return ['create', command.path];
  }

  return [
    'extract',
    ...(command.owner === undefined ? [] : ['--owner', command.owner]),
    command.path,
  ];
}
