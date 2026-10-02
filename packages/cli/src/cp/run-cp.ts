import { loadCliConfig } from '../cli-config';
import type { CliConfig } from '../cli-config';
import { printError } from '../run-action';
import { UsageError } from '../usage-error';
import { createCopyProgress } from './copy-progress';
import type { CopyProgress } from './copy-progress';
import { createLocalExtractor } from './extract-local';
import { openToolExec } from './open-tool-exec';
import { countFileBytes, listLocalEntries, writeLocalEntries } from './pack-local-path';
import { parseCpArgs } from './parse-cp-args';
import type { CpPlan } from './parse-cp-args';

export interface CpOptions {
  // the saved host `--host` named, or null
  readonly host: string | null;
  readonly source: string;
  readonly target: string;

  // the owner in the imp, for an upload: user, uid, user:group or uid:gid
  readonly owner?: string;
}

function writeWarning(text: string): void {
  console.error(`imp: ${text}`);
}

function writeGuestStderr(data: Uint8Array): void {
  process.stderr.write(data);
}

async function runUpload(
  config: CliConfig,
  plan: CpPlan,
  owner: string | undefined,
  progress: CopyProgress,
): Promise<void> {
  // a missing local path fails before the imp wakes
  const entries = await listLocalEntries(plan.localPath);

  progress.setTotal(countFileBytes(entries));

  const exec = await openToolExec({
    config,
    name: plan.name,
    tool: 'tar',
    args: ['extract', ...(owner === undefined ? [] : ['--owner', owner]), plan.guestPath],
    onStdout: () => Promise.resolve(),
    onStderr: writeGuestStderr,
  });

  try {
    await writeLocalEntries(entries, exec.writeStdin, progress, writeWarning);

    exec.endStdin();

    const code = await exec.waitExit();

    progress.finish();

    if (code !== 0) {
      throw new Error(`the copy into ${plan.name} failed`);
    }
  } finally {
    exec.close();
  }
}

async function runDownload(config: CliConfig, plan: CpPlan, progress: CopyProgress): Promise<void> {
  const extractor = createLocalExtractor(plan.localPath, progress, writeWarning);

  const exec = await openToolExec({
    config,
    name: plan.name,
    tool: 'tar',
    args: ['create', plan.guestPath],
    onStdout: extractor.write,
    onStderr: writeGuestStderr,
  });

  try {
    const code = await exec.waitExit();

    const refused = await extractor.end().catch((error: unknown) => {
      // no archive at all: the tool's own error says why
      if (code !== 0) {
        return 0;
      }

      throw error;
    });

    progress.finish();

    if (code !== 0) {
      throw new Error(`the copy out of ${plan.name} failed`);
    }

    if (refused > 0) {
      throw new Error(`${String(refused)} entries were not copied`);
    }
  } finally {
    exec.close();
  }
}

// `imp cp`: one side on this machine, the other in an imp
export async function runCp(options: CpOptions): Promise<void> {
  let config: CliConfig | null = null;

  try {
    config = loadCliConfig(process.env, options.host);

    const plan = parseCpArgs(options.source, options.target);

    if (options.owner !== undefined && plan.direction === 'download') {
      throw new UsageError('--owner sets the owner in the imp: it goes with a copy into the imp');
    }

    const progress = createCopyProgress({
      isTTY: process.stderr.isTTY,
      write: (text) => {
        process.stderr.write(text);
      },
    });

    await (plan.direction === 'upload'
      ? runUpload(config, plan, options.owner, progress)
      : runDownload(config, plan, progress));
  } catch (error) {
    printError(error, config);
  }
}
