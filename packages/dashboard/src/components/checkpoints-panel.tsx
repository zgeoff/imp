import { useMutation, useQuery } from '@tanstack/react-query';
import type { Checkpoint } from '@zgeoff/imp-client';
import { useState } from 'react';
import { formatBytes, formatRelativeTime } from '../lib/format';
import { useImpd } from '../lib/impd';
import { SLOW } from '../lib/live';
import { readText } from '../lib/read-form';
import { useRefresh } from '../lib/use-refresh';
import { Button } from './button';
import styles from './checkpoints-panel.module.css';
import { ConfirmDialog } from './confirm-dialog';
import { ErrorText } from './error-text';
import { ForkDialog } from './fork-dialog';
import tableStyles from './table.module.css';

interface CheckpointsPanelProps {
  readonly name: string;
  readonly nowMs: number;
}

type Pending =
  | { readonly kind: 'restore' | 'delete' | 'fork'; readonly checkpoint: Checkpoint }
  | { readonly kind: 'none' };

export function CheckpointsPanel(props: CheckpointsPanelProps) {
  const impd = useImpd();
  const refresh = useRefresh();
  const [pending, setPending] = useState<Pending>({ kind: 'none' });

  const checkpoints = useQuery({
    ...impd.query.checkpoints.list.queryOptions({ input: { name: props.name } }),
    ...SLOW,
  });

  const create = useMutation({
    mutationFn: (label: string | undefined) =>
      impd.client.checkpoints.create({ name: props.name, ...(label !== undefined && { label }) }),
    onSettled: refresh,
  });

  const handleDialogChange = (open: boolean): void => {
    if (!open) {
      setPending({ kind: 'none' });
    }
  };

  return (
    <section className={styles['panel']}>
      <h2>Checkpoints</h2>
      <form
        className={styles['create']}
        onSubmit={(event) => {
          event.preventDefault();

          const form = event.currentTarget;

          create.mutate(readText(new FormData(form), 'label'));
          form.reset();
        }}
      >
        <input name="label" placeholder="label (optional)" maxLength={64} aria-label="Label" />
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Checkpointing…' : 'Checkpoint now'}
        </Button>
      </form>
      <ErrorText error={create.error ?? checkpoints.error} />
      {checkpoints.data !== undefined && checkpoints.data.length === 0 && (
        <p className={styles['empty']}>No checkpoints yet.</p>
      )}
      {checkpoints.data !== undefined && checkpoints.data.length > 0 && (
        <table className={tableStyles['table']}>
          <thead>
            <tr>
              <th>Checkpoint</th>
              <th>Taken</th>
              <th>Size</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {checkpoints.data.map((checkpoint) => (
              <tr key={checkpoint.id}>
                <td>{checkpoint.label ?? <code>{checkpoint.id}</code>}</td>
                <td>{formatRelativeTime(checkpoint.createdAt, props.nowMs)}</td>
                <td>
                  {checkpoint.sizeBytes === undefined ? '' : formatBytes(checkpoint.sizeBytes)}
                </td>
                <td className={tableStyles['actions']}>
                  <Button
                    onClick={() => {
                      setPending({ kind: 'restore', checkpoint });
                    }}
                  >
                    Restore
                  </Button>
                  <Button
                    onClick={() => {
                      setPending({ kind: 'fork', checkpoint });
                    }}
                  >
                    Fork
                  </Button>
                  <Button
                    tone="danger"
                    onClick={() => {
                      setPending({ kind: 'delete', checkpoint });
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pending.kind === 'restore' && (
        <ConfirmDialog
          open
          onOpenChange={handleDialogChange}
          title={`Restore ${props.name}?`}
          description={`The disk goes back to ${formatCheckpoint(pending.checkpoint)}; what changed since is lost.`}
          confirmLabel="Restore"
          onConfirm={async () => {
            await impd.client.checkpoints.restore({
              name: props.name,
              checkpoint: pending.checkpoint.id,
            });

            await refresh();
          }}
        />
      )}
      {pending.kind === 'delete' && (
        <ConfirmDialog
          open
          onOpenChange={handleDialogChange}
          title="Delete the checkpoint?"
          description={`${formatCheckpoint(pending.checkpoint)} is deleted for good.`}
          confirmLabel="Delete"
          onConfirm={async () => {
            await impd.client.checkpoints.delete({
              name: props.name,
              checkpoint: pending.checkpoint.id,
            });

            await refresh();
          }}
        />
      )}
      {pending.kind === 'fork' && (
        <ForkDialog
          open
          onOpenChange={handleDialogChange}
          source={props.name}
          checkpoint={pending.checkpoint.id}
        />
      )}
    </section>
  );
}

function formatCheckpoint(checkpoint: Checkpoint): string {
  return checkpoint.label === undefined ? `checkpoint ${checkpoint.id}` : `“${checkpoint.label}”`;
}
