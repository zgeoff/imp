import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useImpd } from '../lib/impd';
import { readText } from '../lib/read-form';
import { useRefresh } from '../lib/use-refresh';
import { Button } from './button';
import { ErrorText } from './error-text';
import styles from './form.module.css';
import { Modal } from './modal';

interface ForkDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly source: string;

  // a checkpoint id to fork from; without one, the imp's disk as it is now
  readonly checkpoint?: string;
}

// A fork copies the disk only: the new imp boots fresh, with its own
// entropy and IDs
export function ForkDialog(props: ForkDialogProps) {
  const impd = useImpd();
  const refresh = useRefresh();
  const navigate = useNavigate();

  const fork = useMutation({
    mutationFn: (name: string) =>
      impd.client.imps.fork({
        source: props.source,
        name,
        ...(props.checkpoint !== undefined && { checkpoint: props.checkpoint }),
      }),
    onSuccess: async (imp) => {
      await refresh();

      props.onOpenChange(false);

      await navigate({ to: '/imps/$name', params: { name: imp.name } });
    },
  });

  const from = props.checkpoint === undefined ? 'its disk now' : `checkpoint ${props.checkpoint}`;

  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => {
        fork.reset();
        props.onOpenChange(open);
      }}
      title={`Fork ${props.source}`}
      description={`A new imp from ${from}. It boots fresh: the disk is copied, not the memory.`}
    >
      <form
        className={styles['form']}
        onSubmit={(event) => {
          event.preventDefault();

          const name = readText(new FormData(event.currentTarget), 'name');

          if (name !== undefined) {
            fork.mutate(name);
          }
        }}
      >
        <label className={styles['field']}>
          New name
          <input name="name" required autoComplete="off" />
        </label>
        <ErrorText error={fork.error} />
        <div className={styles['actions']}>
          <Button
            onClick={() => {
              props.onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button tone="primary" type="submit" disabled={fork.isPending}>
            Fork
          </Button>
        </div>
      </form>
    </Modal>
  );
}
