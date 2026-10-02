// `bun run render:deploy`: deploy/imp-host.args.json into deploy/imp-host.service, then that
// unit into bootstrap.sh's copy (the NixOS module reads the JSON itself). `--check` writes
// nothing and fails on a difference, as scripts/render-imp-host.test.ts does under `bun test`.
import { readFileSync, writeFileSync } from 'node:fs';

const ARGS_FILE = 'deploy/imp-host.args.json';
const UNIT_FILE = 'deploy/imp-host.service';
const BOOTSTRAP_FILE = 'deploy/bootstrap.sh';

// unquoted in the unit and in Nix's escapeShellArgs alike
const PLAIN_WORD = /^[\w@%+=:,./-]+$/u;

// `$IMP_PUBLIC_PORTS`: zero or more words from the env file (systemd splits an unbraced $NAME)
const ENV_WORDS = /^\$[A-Z][A-Z0-9_]*$/u;

// from `ExecStart=` through the image, the unit's last word
const EXEC_START = /^ExecStart=\/usr\/bin\/docker run (?:.*\\\n)*\s*\$\{IMP_HOST_IMAGE\}$/mu;
const EMBED_HEAD = "unit_imp_host() {\n  cat <<'EOF'\n";
const EMBED_TAIL = '\nEOF\n}\n';

export function readArgLines(json: string): string[][] {
  const parsed: unknown = JSON.parse(json);

  const lines =
    typeof parsed === 'object' && parsed !== null && 'lines' in parsed ? parsed.lines : null;

  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error(`${ARGS_FILE}: "lines" must be a non-empty array`);
  }

  return lines.map((line: unknown) => {
    if (!Array.isArray(line) || line.length === 0) {
      throw new Error(`${ARGS_FILE}: each line must be a non-empty array of words`);
    }

    return line.map((word: unknown) => {
      if (typeof word !== 'string' || !(PLAIN_WORD.test(word) || ENV_WORDS.test(word))) {
        throw new Error(`${ARGS_FILE}: ${JSON.stringify(word)} is not a plain word`);
      }

      return word;
    });
  });
}

export function renderExecStart(lines: readonly (readonly string[])[]): string {
  const [first = [], ...rest] = lines;
  const tail = rest.map((line) => `  ${line.join(' ')} \\`);

  return [
    `ExecStart=/usr/bin/docker run ${first.join(' ')} \\`,
    ...tail,
    `  \${IMP_HOST_IMAGE}`,
  ].join('\n');
}

export function renderUnit(unit: string, lines: readonly (readonly string[])[]): string {
  if (!EXEC_START.test(unit)) {
    throw new Error(`${UNIT_FILE}: no docker run ExecStart that ends in \${IMP_HOST_IMAGE}`);
  }

  return unit.replace(EXEC_START, renderExecStart(lines));
}

export function renderBootstrap(bootstrap: string, unit: string): string {
  const start = bootstrap.indexOf(EMBED_HEAD);
  const end = bootstrap.indexOf(EMBED_TAIL, start);

  if (start === -1 || end === -1) {
    throw new Error(`${BOOTSTRAP_FILE}: no unit_imp_host heredoc`);
  }

  return (
    bootstrap.slice(0, start + EMBED_HEAD.length) + unit.replace(/\n+$/u, '') + bootstrap.slice(end)
  );
}

export interface Rendered {
  readonly unit: string;
  readonly bootstrap: string;
}

export function render(argsJson: string, unit: string, bootstrap: string): Rendered {
  const nextUnit = renderUnit(unit, readArgLines(argsJson));

  return { unit: nextUnit, bootstrap: renderBootstrap(bootstrap, nextUnit) };
}

function main(): void {
  const unit = readFileSync(UNIT_FILE, 'utf8');
  const bootstrap = readFileSync(BOOTSTRAP_FILE, 'utf8');
  const next = render(readFileSync(ARGS_FILE, 'utf8'), unit, bootstrap);

  const stale = [
    ...(next.unit === unit ? [] : [UNIT_FILE]),
    ...(next.bootstrap === bootstrap ? [] : [BOOTSTRAP_FILE]),
  ];

  if (process.argv.includes('--check')) {
    if (stale.length > 0) {
      console.error(
        `render-imp-host: ${stale.join(' and ')} differ from ${ARGS_FILE}; run bun run render:deploy`,
      );

      process.exit(1);
    }

    console.log(`render-imp-host: ${UNIT_FILE} and ${BOOTSTRAP_FILE} match ${ARGS_FILE}`);

    return;
  }

  writeFileSync(UNIT_FILE, next.unit);
  writeFileSync(BOOTSTRAP_FILE, next.bootstrap);

  console.log(`render-imp-host: wrote ${stale.length > 0 ? stale.join(' and ') : 'nothing new'}`);
}

if (import.meta.main) {
  main();
}
