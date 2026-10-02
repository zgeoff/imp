import { useMutation } from '@tanstack/react-query';
import { Button } from './button';
import { ErrorText } from './error-text';
import formStyles from './form.module.css';
import { Modal } from './modal';

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly onConfirm: () => Promise<unknown>;
}

// Asks before an action that cannot be undone, then runs it and stays open
// with the error if it fails.
export function ConfirmDialog(props: ConfirmDialogProps) {
  const action = useMutation({
    mutationFn: props.onConfirm,
    onSuccess: () => {
      props.onOpenChange(false);
    },
  });

  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => {
        action.reset();
        props.onOpenChange(open);
      }}
      title={props.title}
      description={props.description}
    >
      <ErrorText error={action.error} />
      <div className={formStyles['actions']}>
        <Button
          onClick={() => {
            props.onOpenChange(false);
          }}
        >
          Cancel
        </Button>
        <Button
          tone="danger"
          disabled={action.isPending}
          onClick={() => {
            action.mutate();
          }}
        >
          {props.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
