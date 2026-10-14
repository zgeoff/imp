// pgrep's argv for an imp's Firecracker, whose argv holds the imp's
// directory (imps/<id>/run/api.sock)
export function buildFirecrackerPgrepArgv(id: string): readonly string[] {
  return ['pgrep', '-f', `firecracker.*imps/${id}/`];
}

// the pids that pgrep printed for the imp; throws when none runs
export function readFirecrackerPids(id: string, stdout: string): readonly string[] {
  const pids = stdout.split('\n').filter((pid) => pid !== '');

  if (pids.length === 0) {
    throw new Error(`no firecracker for imp ${id}`);
  }

  return pids;
}
