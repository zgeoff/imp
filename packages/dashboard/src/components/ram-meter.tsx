import type { SystemInfo } from '@zgeoff/imp-client';
import { formatMib } from '../lib/format';
import styles from './ram-meter.module.css';

interface RamMeterProps {
  readonly info: SystemInfo;
}

// The budget as the governor sees it: what awake VMs own, plus what it holds
// back for boots and wakes in flight. Committed (what awake imps could grow
// to) may pass the budget (docs/architecture/sleep-and-wake.md).
export function RamMeter(props: RamMeterProps) {
  const info = props.info;
  const budget = Math.max(info.ramBudgetMib, 1);
  const used = toPercent(info.ramUsedMib, budget);
  const reserved = Math.min(toPercent(info.ramReservedMib, budget), 100 - used);

  return (
    <div className={styles['meter']}>
      <div
        className={styles['bar']}
        role="meter"
        aria-label="RAM in use"
        aria-valuemin={0}
        aria-valuemax={info.ramBudgetMib}
        aria-valuenow={info.ramUsedMib}
      >
        <div className={styles['used']} style={{ width: `${String(used)}%` }} />
        <div className={styles['reserved']} style={{ width: `${String(reserved)}%` }} />
      </div>
      <dl className={styles['figures']}>
        <div>
          <dt>Used</dt>
          <dd>
            {formatMib(info.ramUsedMib)} of {formatMib(info.ramBudgetMib)}
          </dd>
        </div>
        <div>
          <dt>Reserved</dt>
          <dd>{formatMib(info.ramReservedMib)}</dd>
        </div>
        <div>
          <dt>Committed</dt>
          <dd>{formatMib(info.ramCommittedMib)}</dd>
        </div>
        <div>
          <dt>Awake</dt>
          <dd>
            {info.awakeCount} of {info.impCount}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function toPercent(mib: number, budgetMib: number): number {
  return Math.min(100, Math.round((mib / budgetMib) * 1000) / 10);
}
