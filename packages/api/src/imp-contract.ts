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
import { ImageRefSchema } from './image-ref-schema';
import { ImageSchema } from './image-schema';
import { IMP_ERRORS } from './imp-errors';
import { ImpSchema } from './imp-schema';
import { NameSchema } from './name-schema';
import {
  AuditEntrySchema,
  BrokerRuleSchema,
  SecretKindSchema,
  SecretNameSchema,
  SecretSchema,
  SecretValueSchema,
} from './secret-schema';
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
        }),
      )
      .output(ImpSchema),

    list: base.output(z.array(ImpSchema)),

    get: base.input(NameInputSchema).output(ImpSchema),

    destroy: base.input(NameInputSchema).output(EmptySchema),

    // cold boot of a stopped imp; a running imp is returned as it is
    start: base.input(NameInputSchema).output(ImpSchema),

    // agent shutdown, then SIGKILL after a timeout; memory is lost
    stop: base.input(NameInputSchema).output(ImpSchema),

    sleep: base.input(NameInputSchema).output(ImpSchema),

    // restartError: false refuses an imp in error with INVALID_STATE instead
    // of booting it again
    wake: base
      .input(z.object({ name: NameSchema, restartError: z.boolean().optional() }))
      .output(ImpSchema),

    // seconds = 0 releases a hold
    hold: base
      .input(z.object({ name: NameSchema, seconds: z.int().nonnegative() }))
      .output(ImpSchema),

    // grows the disk; a running guest grows its filesystem at once, a
    // sleeping one when it wakes, a stopped one when it boots
    resizeDisk: base
      .input(z.object({ name: NameSchema, diskMib: z.int().min(1024) }))
      .output(ImpSchema),

    url: base
      .input(NameInputSchema)
      .output(z.object({ local: z.url(), https: z.url().nullable(), tailnet: z.url().nullable() })),

    // the egress policy; a change applies at once, whatever the imp's state
    policy: base.input(NameInputSchema).output(EgressPolicySchema),

    setPolicy: base
      .input(z.object({ name: NameSchema, policy: EgressPolicySchema }))
      .output(EgressPolicySchema),

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
  },

  checkpoints: {
    create: base
      .input(z.object({ name: NameSchema, label: z.string().min(1).max(64).optional() }))
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

    // from an image ref the host's docker already has or can pull
    add: base
      .input(z.object({ ref: ImageRefSchema, name: NameSchema.optional() }))
      .output(ImageSchema),

    // contextDir is a path on the imp host, handed to `docker build`
    build: base
      .input(
        z.object({
          // absolute, so docker build cannot read it as a flag
          contextDir: z.string().startsWith('/'),
          name: NameSchema,
          dockerfile: z.string().min(1).optional(),
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

    // removes the disks, checkpoints, images and snapshots no row names;
    // PRECONDITION_FAILED while storage operations keep it busy
    gc: base.input(z.object({ dryRun: z.boolean().optional() })).output(StorageGcSchema),
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

    // ends its dashboard sessions, event streams, sockets and ssh logins too
    delete: base.input(NameInputSchema).output(EmptySchema),

    // binds an SSH key, so a login with it runs as the token; CONFLICT for a
    // key bound to any token or listed in authorized_keys
    addKey: base
      .input(z.object({ name: NameSchema, key: SshPublicKeySchema }))
      .output(SshKeySchema),

    // ends the ssh logins made with the key
    removeKey: base
      .input(z.object({ name: NameSchema, fingerprint: z.string() }))
      .output(EmptySchema),

    // who the caller is, and what it may do
    whoami: base.output(IdentitySchema),
  },
};

export type ImpContract = typeof impContract;
