import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { Imp } from '@zgeoff/imp-client';
import { useState } from 'react';
import type { Impd } from '../lib/impd';
import { useImpd } from '../lib/impd';
import { useRefresh } from '../lib/use-refresh';
import { Button } from './button';
import { ConfirmDialog } from './confirm-dialog';
import { ErrorText } from './error-text';
import styles from './imp-actions.module.css';

interface ImpActionsProps {
  readonly imp: Imp;

  // where to go once the imp is destroyed, when the page shows only it
  readonly afterDestroy?: '/';
}

// The lifecycle buttons that fit the imp's state, and destroy behind a confirm.
export function ImpActions(props: ImpActionsProps) {
  const impd = useImpd();
  const refresh = useRefresh();
  const navigate = useNavigate();
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const name = props.imp.name;

  const lifecycle = useMutation({
    mutationFn: (action: LifecycleAction) => RUN_ACTION[action](impd.client, name),
    onSettled: refresh,
  });

  const buttons = ACTIONS_BY_STATE[props.imp.state].map((action) => (
    <Button
      key={action}
      disabled={lifecycle.isPending}
      onClick={() => {
        lifecycle.mutate(action);
      }}
    >
      {ACTION_LABELS[action]}
    </Button>
  ));

  return (
    <div className={styles['actions']}>
      {buttons}
      {props.imp.state !== 'creating' && (
        <Link className={styles['link']} to="/imps/$name/console" params={{ name }}>
          Console
        </Link>
      )}
      <Button
        tone="danger"
        disabled={lifecycle.isPending}
        onClick={() => {
          setConfirmDestroy(true);
        }}
      >
        Destroy
      </Button>
      <ErrorText error={lifecycle.error} />
      <ConfirmDialog
        open={confirmDestroy}
        onOpenChange={setConfirmDestroy}
        title={`Destroy ${name}?`}
        description="Its disk, memory and checkpoints are deleted. This cannot be undone."
        confirmLabel="Destroy"
        onConfirm={async () => {
          await impd.client.imps.destroy({ name });

          await refresh();

          if (props.afterDestroy !== undefined) {
            await navigate({ to: props.afterDestroy });
          }
        }}
      />
    </div>
  );
}

type LifecycleAction = 'sleep' | 'wake' | 'restart' | 'start' | 'stop';

const ACTION_LABELS: Readonly<Record<LifecycleAction, string>> = {
  sleep: 'Sleep',
  wake: 'Wake',
  restart: 'Restart',
  start: 'Start',
  stop: 'Stop',
};

const ACTIONS_BY_STATE: Readonly<Record<Imp['state'], readonly LifecycleAction[]>> = {
  running: ['sleep', 'stop'],
  sleeping: ['wake', 'stop'],
  stopped: ['start'],

  // an imp in error boots again, losing what it was doing
  error: ['restart', 'stop'],
  creating: [],
};

const RUN_ACTION: Readonly<
  Record<LifecycleAction, (client: Impd['client'], name: string) => Promise<Imp>>
> = {
  sleep: (client, name) => client.imps.sleep({ name }),
  wake: (client, name) => client.imps.wake({ name }),
  restart: (client, name) => client.imps.wake({ name, restartError: true }),
  start: (client, name) => client.imps.start({ name }),
  stop: (client, name) => client.imps.stop({ name }),
};
