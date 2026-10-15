import type { ImpChangeReason, ImpEventDetail } from '@impz/api';
import type { EventBus } from '../events/event-bus';
import type { CheckpointRecord } from './checkpoints';
import type { ImpRecord } from './imps';

// A committed write to the imps or checkpoints table, for the event stream:
// db/imps.ts and db/checkpoints.ts publish every one but activity times and
// the egress policy, which the API does not show.
export type ImpWrite =
  | { readonly kind: 'added'; readonly imp: ImpRecord }
  | {
      readonly kind: 'changed';
      readonly imp: ImpRecord;
      readonly reason: ImpChangeReason;
      readonly detail?: ImpEventDetail;
    }
  | { readonly kind: 'removed'; readonly imp: ImpRecord }
  | { readonly kind: 'checkpointAdded'; readonly checkpoint: CheckpointRecord }
  | { readonly kind: 'checkpointRemoved'; readonly checkpoint: CheckpointRecord };

// The bus a database publishes its imp writes on, after each commit;
// openDatabase takes it, so a test can pass its own.
export type ImpWriteFeed = EventBus<ImpWrite>;
