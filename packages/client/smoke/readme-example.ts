import { ExecError, createImpClient, isDefinedError, safe } from '@zgeoff/imp-client';
import type { Imp } from '@zgeoff/imp-client';

// The README's examples, which scripts/release/check-client-package.sh checks
// in a strict project against the published declarations only. It is never
// run.
const imp = createImpClient({ url: 'http://localhost:7070', token: 'token' });

export async function runReadmeExample(): Promise<Imp> {
  const checkpoint = await imp.checkpoints.create({ name: 'dev', label: 'clean' });

  await imp.imps.fork({ source: 'dev', name: 'dev-2', checkpoint: checkpoint.id });

  const [createError, created] = await safe(imp.imps.create({ name: 'dev' }));

  if (isDefinedError(createError) && createError.code === 'RAM_BUDGET_EXCEEDED') {
    throw new Error(`needs ${String(createError.data.requestedMib)} MiB`);
  }

  const check = await imp.checkServer();
  const result = await imp.run('dev', ['uname', '-a'], { stdin: 'hi' });
  const shell = await imp.openConsole('dev', { cols: 80, rows: 24 });

  await shell.write('exit\n');

  shell.resize(100, 30);

  const exit = await shell.exit.catch((error: unknown) => {
    if (error instanceof ExecError && error.code === 'RESTARTING') {
      return { code: null, signal: null };
    }

    throw error;
  });

  if (result.code !== 0 || exit.code !== 0 || result.stdout.byteLength === 0) {
    throw new Error('unexpected');
  }

  return check.compatible && created !== undefined ? created : imp.requireAwake('dev');
}
