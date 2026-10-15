// One-off: points the code citations of the architecture pages that impz#311 split up at the
// pages and headings that replaced them (GEO-992). Run from the repo root:
// `bun scripts/dev/rewrite-doc-citations.ts`. A second run finds nothing to rewrite.
import { readFileSync, writeFileSync } from 'node:fs';

// an old page, alone or with one of its anchors, and where its text lives now
const TARGETS: Readonly<Record<string, string>> = {
  'agent.md': 'guest/agent.md',
  'agent.md#outer-exec': 'guest/agent.md#execs-and-services',
  'agent.md#the-inner-container': 'guest/agent.md#the-inner-container',
  'agent.md#two-drives': 'guest/agent.md#two-drives-and-a-kernel',
  'backups.md': 'storage/backups.md',
  'backups.md#restore': 'storage/backups.md#restore',
  'backups.md#the-manifest': 'storage/backups.md#what-a-backup-holds',
  'backups.md#whole-host-restore': 'storage/backups.md#a-run',
  'boot-templates.md': 'lifecycle/boot-templates.md',
  'boot-templates.md#claim': 'lifecycle/boot-templates.md#restore',
  'boot-templates.md#key': 'lifecycle/boot-templates.md#the-key',
  'boot-templates.md#limits': 'lifecycle/boot-templates.md#restore',
  'boot-templates.md#make': 'lifecycle/boot-templates.md#build',
  'boot-templates.md#restore': 'lifecycle/boot-templates.md#restore',
  'daemon.md#cgroups': 'isolation.md#cgroups',
  'daemon.md#dashboard': 'control/auth.md#the-dashboard-session',
  'daemon.md#output-offsets': 'guest/sessions.md#generations-boots-and-offsets',
  'daemon.md#session-logs': 'guest/sessions.md#session-logs',
  'daemon.md#sessions-detachable-consoles': 'guest/sessions.md',
  'daemon.md#the-jailer': 'isolation.md#the-jailer',
  'host-contract.md': 'host.md',
  'host-contract.md#privileges': 'host.md#privileges',
  'host-contract.md#the-docker-socket': 'host.md#the-docker-socket',
  'memory.md': 'lifecycle/elastic-memory.md',
  'memory.md#growing': 'lifecycle/elastic-memory.md#the-controller',
  'memory.md#how-the-guest-grows': 'lifecycle/elastic-memory.md#how-the-guest-grows',
  'memory.md#limits': 'lifecycle/elastic-memory.md#limits',
  'memory.md#sleep': 'lifecycle/elastic-memory.md#sleep',
  'memory.md#the-host-limit': 'lifecycle/elastic-memory.md#the-host-limit',
  'memory.md#what-it-costs': 'lifecycle/elastic-memory.md#how-the-guest-grows',
  'moves.md': 'storage/moves.md',
  'moves.md#leases': 'storage/moves.md#the-stream',
  'moves.md#scope': 'storage/moves.md#the-steps',
  'moves.md#the-stream': 'storage/moves.md#the-stream',
  'moves.md#tickets': 'storage/moves.md#one-live-copy',
  'moves.md#warm-moves': 'storage/moves.md#warm-moves',
  'moves.md#zfs-to-zfs': 'storage/moves.md#zfs',
  'networking.md': 'network/egress.md',
  'networking.md#addressing': 'network/networking.md#addressing',
  'networking.md#blocked-ranges': 'network/egress.md#public',
  'networking.md#egress': 'network/egress.md',
  'networking.md#ipv6': 'network/networking.md#ipv6',
  'networking.md#public': 'network/egress.md#public',
  'networking.md#the-firewall': 'network/egress.md#the-firewall',
  'networking.md#the-wake-proxy': 'network/ingress.md#the-wake-proxy',
  'networking.md#urls': 'network/ingress.md#the-wake-proxy',
  'protocol.md#exec': 'guest/protocol.md#the-schema',
  'protocol.md#frames': 'guest/protocol.md#one-request-per-connection',
  'protocol.md#servicesadd-servicesremove-servicesrestart': 'guest/agent.md#execs-and-services',
  'protocol.md#sessions': 'guest/sessions.md#in-the-guest',
  'protocol.md#transport': 'guest/protocol.md#one-request-per-connection',
  'sleep-and-wake.md': 'lifecycle/sleep-and-wake.md',
  'sleep-and-wake.md#1-result': 'lifecycle/sleep-and-wake.md#what-survives-a-sleep',
  'sleep-and-wake.md#4-gotchas': 'lifecycle/sleep-and-wake.md#sleep',
  'sleep-and-wake.md#5-ram-what-the-governor-measures':
    'lifecycle/ram-governor.md#what-it-measures',
  'sleep-and-wake.md#8-ksm-sharing-identical-guest-pages': 'lifecycle/ram-governor.md#ksm',
  'sleep-and-wake.md#idle-detection': 'lifecycle/sleep-and-wake.md#idle-detection',
  'sleep-and-wake.md#restarts': 'lifecycle/lifecycle.md#recovery-after-a-restart',
  'sleep-and-wake.md#sleep': 'lifecycle/sleep-and-wake.md#sleep',
  'sleep-and-wake.md#the-cpu': 'lifecycle/sleep-and-wake.md#snapshot-identity',
  'sleep-and-wake.md#the-ram-governor': 'lifecycle/ram-governor.md',
  'sleep-and-wake.md#the-watchdog': 'lifecycle/lifecycle.md#the-watchdog',
  'sleep-and-wake.md#what-survives-a-sleep': 'lifecycle/sleep-and-wake.md#what-survives-a-sleep',
  'sleep-and-wake.md#young-guests': 'lifecycle/sleep-and-wake.md#young-guests',
  'storage.md': 'storage/storage.md',
  'storage.md#checkpoints-restores-and-forks': 'storage/storage.md#checkpoints-restores-and-forks',
  'storage.md#cleanup': 'storage/disk-space.md#the-sweep',
  'storage.md#disk-budget': 'storage/disk-space.md#the-budget',
  'storage.md#disk-sizes': 'storage/disk-space.md#disk-sizes',
  'storage.md#images-any-oci-image': 'storage/images.md#from-an-oci-image-to-a-disk',
  'storage.md#reclaim': 'storage/storage.md#zfs',
  'storage.md#system-files': 'storage/storage.md#system-files',
  'storage.md#the-data-directory': 'storage/storage.md#the-data-directory',
  'storage.md#versions': 'storage/storage.md#zfs',
  'storage.md#what-a-sweep-takes': 'storage/disk-space.md#the-sweep',
  'storage.md#xfs-with-reflink': 'storage/storage.md',
  'storage.md#zfs': 'storage/storage.md#zfs',
};

// a citation whose comment is about a part of the old page that moved elsewhere than the rest,
// by the line it sat on before this rewrite
const SITE_TARGETS: Readonly<Record<string, string>> = {
  'deploy/imp-host.seccomp.test.ts:7': 'host.md#privileges',
  'e2e/lib/jail-host.ts:7': 'isolation.md#the-jailer',
  'e2e/suites/jail-oom.e2e.ts:21': 'isolation.md#cgroups',
  'e2e/suites/jail.e2e.ts:27': 'isolation.md#the-jailer',
  'e2e/suites/sessions.e2e.ts:15': 'guest/sessions.md',
  'packages/cli/src/commands/move.test.ts:453': 'storage/moves.md#one-live-copy',
  'packages/cli/src/commands/move.test.ts:526': 'storage/moves.md#one-live-copy',
  'packages/daemon/src/build-system-routes.ts:51': 'lifecycle/ram-governor.md#what-it-measures',
  'packages/daemon/src/config.ts:190': 'lifecycle/ram-governor.md#admission',
  'packages/daemon/src/docker-proxy/main.ts:3': 'host.md#the-docker-socket',
  'packages/daemon/src/docker-proxy/proxy.ts:3': 'host.md#the-docker-socket',
  'packages/daemon/src/exec/exec-tickets.ts:8': 'control/api.md#exec-and-tunnels',
  'packages/daemon/src/governor/ram-governor.test.ts:10': 'lifecycle/ram-governor.md#enforcement',
  'packages/daemon/src/images/image-naming.ts:42': 'guest/protocol.md#contract-tests',
  'packages/daemon/src/sleep/snapshot-meta.ts:18': 'lifecycle/sleep-and-wake.md#snapshot-identity',
  'packages/daemon/src/storage/storage-backend.ts:44': 'storage/disk-space.md#usage',
  'packages/dashboard/src/components/ram-meter.tsx:11': 'lifecycle/ram-governor.md',
};

// the old page, an anchor that may sit after a comment line break, and the numbered gotcha
// the old page listed, which the new pages do not number
const CITATION =
  /docs\/architecture\/(?<page>agent|backups|boot-templates|daemon|host-contract|memory|moves|networking|protocol|sleep-and-wake|storage)\.md(?:(?<wrap>\n\s*\/\/ )?#(?<anchor>[\w-]+))?(?<gotcha>, gotcha \d+)?/gu;

function main(): void {
  const unused = new Set(Object.keys(SITE_TARGETS));

  let count = 0;

  for (const file of listCodeFiles()) {
    const text = readFileSync(file, 'utf8');
    const sites = buildRewrite(file, text);

    if (sites.text !== text) {
      writeFileSync(file, sites.text);
    }

    for (const site of sites.rewritten) {
      unused.delete(site);
    }

    count += sites.rewritten.length;
  }

  // a run that rewrote anything used every site; a second run rewrites nothing
  if (count > 0 && unused.size > 0) {
    throw new Error(`no citation at ${[...unused].join(', ')}`);
  }

  console.log(`rewrite-doc-citations: ${String(count)} citations rewritten`);
}

function listCodeFiles(): string[] {
  const result = Bun.spawnSync(['git', 'ls-files', '-z', '--', ':!*.md'], { stdout: 'pipe' });

  if (result.exitCode !== 0) {
    throw new Error('git ls-files failed');
  }

  return result.stdout.toString().split('\0').filter(Boolean);
}

// the file's text with each citation rewritten, and the file:line of each one
function buildRewrite(file: string, text: string): { text: string; rewritten: string[] } {
  const rewritten: string[] = [];

  const result = text.replaceAll(CITATION, (...args) => {
    const offset = args.at(-3) as number;
    const groups = args.at(-1) as Record<string, string | undefined>;
    const site = `${file}:${String(countLines(text, offset))}`;

    const key =
      groups['anchor'] === undefined
        ? `${groups['page']}.md`
        : `${groups['page']}.md#${groups['anchor']}`;

    const target = SITE_TARGETS[site] ?? TARGETS[key];

    if (target === undefined) {
      throw new Error(`${site}: no new page for docs/architecture/${key}`);
    }

    rewritten.push(site);

    return renderCitation(target, groups['wrap']);
  });

  return { text: result, rewritten };
}

function countLines(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

// keeps a comment's line break before the anchor where the old citation had one; the one such
// citation, in e2e/suites/inner-restart.e2e.ts, was reflowed by hand after the run, since
// check-doc-citations reads only a path and anchor on one line
function renderCitation(target: string, wrap: string | undefined): string {
  const [page = '', anchor] = target.split('#');
  const path = `docs/architecture/${page}`;

  if (anchor === undefined) {
    return path;
  }

  return `${path}${wrap ?? ''}#${anchor}`;
}

if (import.meta.main) {
  main();
}
