import type { Builders } from '../images/builder-imps';
import { createGuestExec } from '../images/guest-exec';
import { PIN_INSPECT_FORMAT } from '../images/image-pin';
import { buildStubGuest } from './build-stub-guest';
import type { StubAnswer, StubRun } from './build-stub-guest';

export interface StubImageBuilderOptions {
  // the chunks `docker export` streams, as a builder sends its tree
  readonly exported: readonly Uint8Array[];

  // the registry digest every image the engine inspects reports
  readonly repoDigest: string;

  // what the engine answers a pull; a pull succeeds by default
  readonly onPull?: (run: StubRun) => Promise<StubAnswer> | StubAnswer;

  // runs as an export starts, before its output
  readonly onExport?: () => Promise<void>;

  // after its output, the export stays open until impd closes it
  readonly isExportStalled?: boolean;

  // what the config inspect of the built tag prints; BUILT_CONFIG by default
  readonly config?: string;

  // the architecture docker reports for a pulled image; amd64 by default
  readonly architecture?: string;

  // a step that fails in the engine with this stderr and exit 1
  readonly failures?: Readonly<Partial<Record<StubBuilderStep, string>>>;
}

// the engine steps a test can fail: the pin inspect of a pulled image,
// its tag, and the built tag's config inspect, create and export
type StubBuilderStep = 'pin' | 'tag' | 'config' | 'create' | 'export';

// what `docker image inspect --format {{json .Config}}` prints for the built tag
const BUILT_CONFIG = '{"Cmd":["/bin/sh"],"Env":["PATH=/bin"]}';

// the container `docker create` makes in the builder
export const STUB_BUILDER_CONTAINER = 'e'.repeat(64);

// the step a builder's docker call is, when a test can fail it
function readStep(argv: string, ref: string): StubBuilderStep | null {
  const steps: Readonly<Record<string, StubBuilderStep>> = {
    [`image inspect --format ${PIN_INSPECT_FORMAT} ${ref}`]: 'pin',
    [`tag ${argv.split(' ')[1] ?? ''} imp-build:latest`]: 'tag',
    'image inspect --format {{json .Config}} imp-build:latest': 'config',
    'create imp-build:latest /bin/true': 'create',
    [`export ${STUB_BUILDER_CONTAINER}`]: 'export',
  };

  return steps[argv] ?? null;
}

// A builder's engine on linux/amd64 behind its agent: it pulls and pins
// any image, builds what it gets and exports `exported`. `builders` runs
// builds on it with no builder imp; the real lifecycle takes `guest.open`.
export function buildStubImageBuilder(options: Readonly<StubImageBuilderOptions>) {
  const builtDockerfiles: string[] = [];
  const counts = { boots: 0, live: 0 };

  const buildAnswer = (run: StubRun): Promise<StubAnswer> | StubAnswer => {
    const step = readStep(run.argv.slice(1).join(' '), run.argv.at(-1) ?? '');
    const failure = step === null ? undefined : options.failures?.[step];

    if (failure !== undefined) {
      return { code: 1, stderr: `${failure}\n` };
    }

    return buildStepAnswer(run);
  };

  const buildStepAnswer = async (run: StubRun): Promise<StubAnswer> => {
    const argv = run.argv.slice(1).join(' ');
    const ref = run.argv.at(-1) ?? '';

    if (argv.startsWith('info ')) {
      return {};
    }

    if (argv.startsWith('version ')) {
      return { stdout: '"linux" "x86_64"\n' };
    }

    if (argv.startsWith('pull ')) {
      return options.onPull === undefined ? {} : options.onPull(run);
    }

    if (argv.startsWith('tag ')) {
      return {};
    }

    if (argv === `image inspect --format ${PIN_INSPECT_FORMAT} ${ref}`) {
      const inspect = {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`${ref.split(':')[0] ?? ''}@${options.repoDigest}`],
        Os: 'linux',
        Architecture: options.architecture ?? 'amd64',
        Config: {},
      };

      return { stdout: JSON.stringify(inspect) };
    }

    if (argv.startsWith('image inspect --format {{.Id}} docker/dockerfile')) {
      return { stdout: `sha256:${'f'.repeat(64)}\n` };
    }

    if (argv.startsWith('build ')) {
      const context = await run.readStdin();

      const dockerfile = Bun.spawnSync(['tar', '-xO', '-f', '-', 'Dockerfile'], { stdin: context });

      builtDockerfiles.push(new TextDecoder().decode(dockerfile.stdout));

      return { stderr: '#1 DONE\n' };
    }

    if (argv === 'image inspect --format {{json .Config}} imp-build:latest') {
      return { stdout: options.config ?? BUILT_CONFIG };
    }

    if (argv === 'create imp-build:latest /bin/true') {
      return { stdout: `${STUB_BUILDER_CONTAINER}\n` };
    }

    if (argv === `export ${STUB_BUILDER_CONTAINER}`) {
      await options.onExport?.();

      return { stdout: options.exported, stall: options.isExportStalled === true };
    }

    return { code: 1, stderr: `the stub builder has no ${argv}` };
  };

  const guest = buildStubGuest(buildAnswer);

  const builders: Builders = {
    withBuilder: (_signal, run) => {
      counts.boots += 1;
      counts.live += 1;

      // the builder goes however the build ends
      return Promise.try(run, createGuestExec(guest.open)).finally(() => {
        counts.live -= 1;
      });
    },
    removeLeftovers: () => Promise.resolve(),
  };

  return {
    guest,
    builders,
    builtDockerfiles,

    // builders booted, and builders still up
    readBoots: () => counts.boots,
    readLive: () => counts.live,
  };
}
