import { eventIterator, oc } from '@orpc/contract';
import * as z from 'zod';
import { ApiCallSchema } from './api-call-schema';
import {
  BackupCheckSubsetSchema,
  BackupRestoreSchema,
  BackupRunSchema,
  BackupStatusSchema,
} from './backup-schema';
import { CheckpointSchema } from './checkpoint-schema';
import { EgressPolicySchema } from './egress-schema';
import { ImpEventSchema } from './event-schema';
import { ExposeInputSchema, ExposeResultSchema } from './exposure-schema';
import { DockerfilePathSchema } from './image-build-protocol';
import { ImageRefSchema } from './image-ref-schema';
import { ImageSchema } from './image-schema';
import { IMP_ERRORS } from './imp-errors';
import { ImpSchema } from './imp-schema';
import { LeaseLabelSchema, LeaseSchema, LeaseTtlSchema } from './lease-schema';
import { NameSchema } from './name-schema';
import { MAX_CREATE_NETWORKS, NetworkJoinSchema, NetworkSchema } from './network-schema';
import {
  AuditEntrySchema,
  BrokerRuleSchema,
  SecretKindSchema,
  SecretNameSchema,
  SecretSchema,
  SecretValueSchema,
} from './secret-schema';
import {
  ServiceDefSchema,
  ServiceListSchema,
  ServiceLogSchema,
  ServiceNameSchema,
} from './service-schema';
import { SessionNameSchema, SessionSchema } from './session-schema';
import { StorageGcSchema } from './storage-schema';
import { SystemInfoSchema } from './system-info-schema';
import {
  IdentitySchema,
  ImpPatternSchema,
  MAX_SSH_KEYS,
  ScopeSchema,
  SshKeySchema,
  SshPublicKeySchema,
  TokenSchema,
} from './token-schema';

const base = oc.errors(IMP_ERRORS);
const NameInputSchema = z.object({ name: NameSchema });

// a checkpoint is addressed by its id or by its label
const CheckpointRefSchema = z.string().min(1);
const EmptySchema = z.object({});

// a sleep or stop that ends the imp's leases rather than fail with LEASED
const ForceInputSchema = z.object({ name: NameSchema, force: z.boolean().optional() });

// `hold` is the label `imps.hold` writes, which never blocks a sleep: a lease
// with it would not lease anything
const LeaseInputSchema = z.object({
  name: NameSchema,
  label: LeaseLabelSchema.refine((label) => label !== 'hold', 'hold is the label imps.hold writes'),
  ttlSeconds: LeaseTtlSchema,
});

// cores; below 0.1 the VMM thread starves and a boot times out. impd also
// refuses more than the host has.
const CpuLimitSchema = z.number().min(0.1);

// cgroup v2 cpu.weight; 100 is the default share
const CpuWeightSchema = z.int().min(1).max(10_000);

// a docker image ref, or an imp whose disk becomes a template
const ImageAddInputSchema = z.union([
  z.object({ ref: ImageRefSchema, name: NameSchema.optional() }),
  z.object({ imp: NameSchema, name: NameSchema }),
]);

export const impContract = {
  imps: {
    create: base
      .input(
        z.object({
          name: NameSchema.optional(),
          image: NameSchema.optional(),
          vcpus: z.int().min(1).max(32).optional(),
          memoryMib: z.int().min(128).optional(),

          // at least the image's filesystem; IMP_DEFAULT_DISK_GIB by default
          diskMib: z.int().min(1024).optional(),

          // the guest port the wake proxy forwards HTTP to (default 8080)
          httpPort: z.int().min(1).max(65_535).optional(),

          // what the imp may reach directly (default open)
          policy: EgressPolicySchema.optional(),

          // null, the default, is no limit
          cpuLimit: CpuLimitSchema.nullable().optional(),
          cpuWeight: CpuWeightSchema.optional(),

          // networks it joins, which must exist; host-wide callers only
          networks: z.array(NameSchema).max(MAX_CREATE_NETWORKS).optional(),
        }),
      )
      .output(ImpSchema),

    list: base.output(z.array(ImpSchema)),

    get: base.input(NameInputSchema).output(ImpSchema),

    destroy: base.input(NameInputSchema).output(EmptySchema),

    // cold boot of a stopped imp; a running imp is returned as it is
    start: base.input(NameInputSchema).output(ImpSchema),

    // agent shutdown, then SIGKILL after a timeout; memory is lost. LEASED
    // on an imp with a lease from `leases.*`, unless `force` ends them.
    stop: base.input(ForceInputSchema).output(ImpSchema),

    // LEASED as for stop
    sleep: base.input(ForceInputSchema).output(ImpSchema),

    // restartError: false refuses an imp in error with INVALID_STATE instead
    // of booting it again
    wake: base
      .input(z.object({ name: NameSchema, restartError: z.boolean().optional() }))
      .output(ImpSchema),

    // the caller's lease labelled `hold`, which never blocks a sleep or a
    // stop; seconds = 0 releases it and a hold from before leases
    hold: base
      .input(z.object({ name: NameSchema, seconds: z.int().nonnegative() }))
      .output(ImpSchema),

    // grows the disk; a running guest grows its filesystem at once, a
    // sleeping one when it wakes, a stopped one when it boots
    resizeDisk: base
      .input(z.object({ name: NameSchema, diskMib: z.int().min(1024) }))
      .output(ImpSchema),

    url: base.input(NameInputSchema).output(
      z.object({
        local: z.url(),
        https: z.url().nullable(),

        // https://<name>.<domain> from the internet, while the imp is public
        public: z.url().nullable(),

        // the imp's own name on the tailnet, once impd serves it
        service: z.url().nullable(),
        tailnet: z.url().nullable(),
      }),
    ),

    // the egress policy; a change applies at once, whatever the imp's state
    policy: base.input(NameInputSchema).output(EgressPolicySchema),

    setPolicy: base
      .input(z.object({ name: NameSchema, policy: EgressPolicySchema }))
      .output(EgressPolicySchema),

    // serves the imp to the internet at https://<name>.<domain>; an imp
    // already public gets a new credential. PRECONDITION_FAILED without
    // IMP_PUBLIC_IP.
    expose: base.input(ExposeInputSchema).output(ExposeResultSchema),

    // back to the tailnet only, at once
    unexpose: base.input(NameInputSchema).output(ImpSchema),

    // disk only, with the source's egress policy: a memory fork would
    // duplicate entropy and IDs across clones
    fork: base
      .input(
        z.object({
          source: NameSchema,
          name: NameSchema,
          checkpoint: CheckpointRefSchema.optional(),
        }),
      )
      .output(ImpSchema),

    // a running VM takes a new CPU limit or weight at once, a sleeping or
    // stopped one when it next starts; vcpus only while stopped. A null
    // cpuLimit removes the limit. httpPort applies to the next request.
    update: base
      .input(
        z.object({
          name: NameSchema,
          cpuLimit: CpuLimitSchema.nullable().optional(),
          cpuWeight: CpuWeightSchema.optional(),
          vcpus: z.int().min(1).max(32).optional(),
          httpPort: z.int().min(1).max(65_535).optional(),
        }),
      )
      .output(ImpSchema),
  },

  // Each caller's own hold on an imp (docs/guides/leases.md). Only the
  // caller's leases are touched; the label `hold` is the one `imps.hold` writes.
  leases: {
    // boots or wakes the imp, then creates the lease or moves its end later;
    // RAM_BUDGET_EXCEEDED keeps no lease
    acquire: base.input(LeaseInputSchema).output(LeaseSchema),

    // LEASE_NOT_HELD once the lease ended or was released; wakes nothing
    renew: base.input(LeaseInputSchema).output(LeaseSchema),

    release: base
      .input(z.object({ name: NameSchema, label: LeaseLabelSchema }))
      .output(z.object({ released: z.boolean() })),

    // live leases, of every imp the caller may reach unless it names one
    list: base
      .input(z.object({ name: NameSchema.optional(), label: LeaseLabelSchema.optional() }))
      .output(z.array(LeaseSchema)),
  },

  checkpoints: {
    create: base
      .input(
        z.object({
          name: NameSchema,
          label: z.string().min(1).max(64).optional(),
        }),
      )
      .output(CheckpointSchema),

    list: base.input(NameInputSchema).output(z.array(CheckpointSchema)),

    restore: base
      .input(z.object({ name: NameSchema, checkpoint: CheckpointRefSchema }))
      .output(ImpSchema),

    delete: base
      .input(z.object({ name: NameSchema, checkpoint: CheckpointRefSchema }))
      .output(EmptySchema),
  },

  // off-host backups with restic (docs/architecture/backups.md); every call
  // fails with PRECONDITION_FAILED when the host has no repository set
  backups: {
    run: base.output(BackupRunSchema),

    list: base.output(BackupStatusSchema),

    // One imp by name, or all of them. `at` picks the newest backup at or
    // before it, in UTC; the newest by default. A restored imp is stopped.
    restore: base
      .input(
        z.object({
          name: NameSchema.optional(),
          all: z.boolean().optional(),
          at: z.date().optional(),

          // the restored imp's name, when one other than its own
          as: NameSchema.optional(),

          // with `all`, adds the backup's imps to a host that has imps already
          merge: z.boolean().optional(),
        }),
      )
      .output(BackupRestoreSchema),

    check: base.input(z.object({ subset: BackupCheckSubsetSchema.optional() })).output(EmptySchema),
  },

  images: {
    list: base.output(z.array(ImageSchema)),

    // From an image ref the host's docker already has or can pull, or a
    // template from an imp's disk (docs/guides/templates.md). A template
    // name made again points at the new disk; imps made before keep theirs.
    add: base.input(ImageAddInputSchema).output(ImageSchema),

    // contextDir is a path on the imp host, handed to `docker build`; a
    // context on the client's machine streams to IMAGE_BUILD_PATH instead
    build: base
      .input(
        z.object({
          // absolute, so docker build cannot read it as a flag
          contextDir: z.string().startsWith('/'),
          name: NameSchema,
          dockerfile: DockerfilePathSchema.optional(),
        }),
      )
      .output(ImageSchema),

    delete: base.input(NameInputSchema).output(EmptySchema),
  },

  exec: {
    // a single-use ticket for one `/exec` WebSocket to this imp (exec-protocol)
    ticket: base
      .input(NameInputSchema)
      .output(z.object({ ticket: z.string(), expiresAt: z.date() })),
  },

  sessions: {
    // a running imp's live sessions; a sleeping imp's as it went to sleep,
    // without waking it; none for a stopped imp
    list: base.input(NameInputSchema).output(z.array(SessionSchema)),

    // wakes a sleeping imp; SIGHUP, then SIGKILL after 2 s
    kill: base
      .input(z.object({ name: NameSchema, session: SessionNameSchema }))
      .output(EmptySchema),
  },

  // the services the imp's agent supervises (docs/guides/services.md); each
  // call but list and a log follow wakes a sleeping imp and boots a stopped
  // one, as an exec does
  services: {
    list: base.input(NameInputSchema).output(ServiceListSchema),

    // writes /etc/imp/services.d/<service>.json and starts it; CONFLICT
    // when the service exists, unless `replace`
    add: base
      .input(
        z.object({
          name: NameSchema,
          service: ServiceDefSchema,
          replace: z.boolean().optional(),
        }),
      )
      .output(EmptySchema),

    // stops it and deletes its file; its logs stay
    remove: base
      .input(z.object({ name: NameSchema, service: ServiceNameSchema }))
      .output(EmptySchema),

    // stops it and starts it from its file, so an edit to the file applies
    restart: base
      .input(z.object({ name: NameSchema, service: ServiceNameSchema }))
      .output(EmptySchema),

    // the last `lines` lines (default 100) of a service's log, or of every
    // service's (10 000 in all); `follow` goes on, never waking the imp or
    // keeping it awake (docs/guides/services.md#logs)
    logs: base
      .input(
        z.object({
          name: NameSchema,
          service: ServiceNameSchema.optional(),
          lines: z.int().min(0).max(100_000).optional(),
          follow: z.boolean().optional(),
        }),
      )
      .output(eventIterator(ServiceLogSchema)),
  },

  // credentials the broker adds to an imp's requests (docs/guides/connectors.md)
  secrets: {
    // `replace` swaps the value and rules of a secret that exists; `rules`
    // is for kind `custom` only, where it is required
    add: base
      .input(
        z.object({
          name: SecretNameSchema,
          kind: SecretKindSchema,
          value: SecretValueSchema,
          rules: z.array(BrokerRuleSchema).min(1).max(16).optional(),
          replace: z.boolean().optional(),
        }),
      )
      .output(SecretSchema),

    list: base.output(z.array(SecretSchema)),

    // revokes it from every imp
    delete: base.input(z.object({ name: SecretNameSchema })).output(EmptySchema),
  },

  // private networks between imps (docs/guides/networks.md)
  networks: {
    list: base.output(z.array(NetworkSchema)),

    create: base.input(NameInputSchema).output(NetworkSchema),

    // its imps' connections to one another end
    delete: base.input(NameInputSchema).output(EmptySchema),

    // `name` is the imp: it and the network's other imps reach one another
    // from now on, whatever their egress policies; joining twice is a no-op
    join: base.input(z.object({ network: NameSchema, name: NameSchema })).output(NetworkJoinSchema),

    // the trust warnings for each network the imp is on, as a join gives
    // them: after a policy change, or a create with networks
    warnings: base.input(NameInputSchema).output(z.array(z.string())),

    // its connections to the others end; leaving one it is not on is a no-op
    leave: base.input(z.object({ network: NameSchema, name: NameSchema })).output(NetworkSchema),
  },

  grants: {
    // the broker adds the secret to the imp's requests to its hosts
    add: base.input(z.object({ name: NameSchema, secret: SecretNameSchema })).output(EmptySchema),

    delete: base
      .input(z.object({ name: NameSchema, secret: SecretNameSchema }))
      .output(EmptySchema),

    // the secrets granted to the imp
    list: base.input(NameInputSchema).output(z.array(SecretNameSchema)),
  },

  audit: {
    // newest first; one imp's, or every imp's
    list: base
      .input(
        z.object({
          name: NameSchema.optional(),
          limit: z.int().min(1).max(1000).optional(),
        }),
      )
      .output(z.array(AuditEntrySchema)),

    // API calls that changed something and sessions opened, newest first;
    // those that named one imp, or all of them
    calls: base
      .input(
        z.object({
          name: NameSchema.optional(),
          limit: z.int().min(1).max(1000).optional(),
        }),
      )
      .output(z.array(ApiCallSchema)),
  },

  // every lifecycle event (docs/guides/events.md): first each imp as
  // `ImpAdded`, then each event as it happens
  events: {
    stream: base.output(eventIterator(ImpEventSchema)),
  },

  system: {
    info: base.output(SystemInfoSchema),

    // removes the crash leftovers no row names and lists the orphans it
    // keeps, or retires them with `orphans`; PRECONDITION_FAILED while
    // storage operations keep it busy (docs/architecture/storage.md#cleanup)
    gc: base
      .input(z.object({ dryRun: z.boolean().optional(), orphans: z.boolean().optional() }))
      .output(StorageGcSchema),
  },

  // named API tokens (docs/guides/tokens.md); the root token in
  // <dataDir>/token is not one of them
  tokens: {
    list: base.output(z.array(TokenSchema)),

    // the secret is in the answer once and never again
    create: base
      .input(
        z.object({
          name: NameSchema,
          scope: ScopeSchema,
          imps: z.array(ImpPatternSchema).min(1).max(32).optional(),
          sshKeys: z.array(SshPublicKeySchema).min(1).max(MAX_SSH_KEYS).optional(),
        }),
      )
      .output(z.object({ token: TokenSchema, secret: z.string() })),

    // ends its dashboard sessions, event streams, sockets and ssh logins too;
    // CONFLICT while authorized_keys lists one of its keys
    delete: base.input(NameInputSchema).output(EmptySchema),

    // binds an SSH key, so a login with it runs as the token; CONFLICT for a
    // key bound to any token or listed in authorized_keys
    addKey: base
      .input(z.object({ name: NameSchema, key: SshPublicKeySchema }))
      .output(SshKeySchema),

    // ends the ssh logins made with the key; CONFLICT while authorized_keys
    // lists it, since unbinding would hand it every imp
    removeKey: base
      .input(z.object({ name: NameSchema, fingerprint: z.string() }))
      .output(EmptySchema),

    // who the caller is, and what it may do
    whoami: base.output(IdentitySchema),
  },
};

export type ImpContract = typeof impContract;
