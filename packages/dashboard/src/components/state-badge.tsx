import type { ImpState } from '@zgeoff/imp-client';
import styles from './state-badge.module.css';

interface StateBadgeProps {
  readonly state: ImpState;
}

export function StateBadge(props: StateBadgeProps) {
  return (
    <span className={`${styles['badge'] ?? ''} ${styles[props.state] ?? ''}`}>{props.state}</span>
  );
}
