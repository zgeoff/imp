import { useMutation } from '@tanstack/react-query';
import type { Imp } from '@zgeoff/imp-client';
import { formatBytes, formatCpuUse, formatDuration } from '../lib/format';
import { useImpd } from '../lib/impd';
import { readInteger, readText } from '../lib/read-form';
import { useRefresh } from '../lib/use-refresh';
import { Button } from './button';
import styles from './cpu-panel.module.css';
import { ErrorText } from './error-text';

interface CpuPanelProps {
  readonly imp: Imp;
}

interface CpuChange {
  readonly cpuLimit: number | null;
  readonly cpuWeight: number | undefined;
}

// The imp's CPU use from impd's last sample, and its limit and weight. A
// change applies at once to a running imp (docs/guides/cpu-limits.md).
export function CpuPanel(props: CpuPanelProps) {
  const impd = useImpd();
  const refresh = useRefresh();
  const imp = props.imp;
  const limit = imp.cpu?.limit ?? null;
  const weight = imp.cpu?.weight ?? 100;

  const update = useMutation({
    mutationFn: (change: CpuChange) =>
      impd.client.imps.update({
        name: imp.name,
        cpuLimit: change.cpuLimit,
        ...(change.cpuWeight !== undefined && { cpuWeight: change.cpuWeight }),
      }),
    onSettled: refresh,
  });

  return (
    <section className={styles['panel']}>
      <h2>CPU</h2>
      <ResourceDetails imp={imp} />
      <form
        key={`${String(limit)}-${String(weight)}`}
        className={styles['form']}
        onSubmit={(event) => {
          event.preventDefault();

          const form = new FormData(event.currentTarget);

          const limitText = readText(form, 'limit');

          update.mutate({
            cpuLimit: limitText === undefined ? null : Number(limitText),
            cpuWeight: readInteger(form, 'weight'),
          });
        }}
      >
        <label className={styles['field']}>
          Limit (CPUs)
          <input
            name="limit"
            type="number"
            min="0.1"
            step="any"
            placeholder="none"
            defaultValue={limit ?? ''}
          />
        </label>
        <label className={styles['field']}>
          Weight
          <input name="weight" type="number" min="1" max="10000" defaultValue={weight} />
        </label>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </form>
      <ErrorText error={update.error} />
    </section>
  );
}

function ResourceDetails(props: CpuPanelProps) {
  const imp = props.imp;
  const sample = imp.resources?.sample;

  return (
    <dl className={styles['details']}>
      <dt>CPU now</dt>
      <dd>{sample === undefined ? 'not awake' : formatCpuUse(imp)}</dd>
      {sample !== undefined && (
        <>
          <dt>Throttled</dt>
          <dd>{formatDuration(sample.cpuThrottledMs)}</dd>
          <dt>Network</dt>
          <dd>
            {formatBytes(sample.netRxBytes)} in, {formatBytes(sample.netTxBytes)} out
          </dd>
        </>
      )}
      {imp.resources !== undefined && (
        <>
          <dt>Wakes</dt>
          <dd>{imp.resources.wakeCount}</dd>
          <dt>Awake for</dt>
          <dd>{formatDuration(imp.resources.awakeMs)}</dd>
        </>
      )}
    </dl>
  );
}
