import type { ImpRecord } from '../db/imps';
import type { ImpPaths } from '../storage/data-layout';
import type { SessionLogImp } from './session-log-service';

// what the session logs need of an imp: its state, its agent and its logs
export function findSessionLogImp(
  findPaths: (impId: string) => ImpPaths,
  imp: Readonly<Pick<ImpRecord, 'id' | 'state'>>,
): SessionLogImp {
  const paths = findPaths(imp.id);

  return {
    id: imp.id,
    state: imp.state,
    vsockPath: paths.vsockSocket,
    sessionLogsDir: paths.sessionLogsDir,
  };
}
