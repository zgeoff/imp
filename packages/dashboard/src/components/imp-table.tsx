import { Link } from '@tanstack/react-router';
import type { Imp } from '@zgeoff/imp-client';
import { formatCpuUse, formatMib, formatRelativeTime } from '../lib/format';
import { ImpActions } from './imp-actions';
import { ImpNotes } from './imp-notes';
import { StateBadge } from './state-badge';
import styles from './table.module.css';

interface ImpTableProps {
  readonly imps: readonly Imp[];
  readonly nowMs: number;
}

export function ImpTable(props: ImpTableProps) {
  return (
    <table className={styles['table']}>
      <thead>
        <tr>
          <th>Imp</th>
          <th>State</th>
          <th className={styles['numeric']}>RAM</th>
          <th className={styles['numeric']}>CPU</th>
          <th>Last active</th>
          <th>URL</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {props.imps.map((imp) => (
          <tr key={imp.id}>
            <td>
              <Link to="/imps/$name" params={{ name: imp.name }}>
                {imp.name}
              </Link>
              <ImpNotes imp={imp} nowMs={props.nowMs} />
            </td>
            <td>
              <StateBadge state={imp.state} />
            </td>
            <td className={styles['numeric']}>
              {imp.ramMib === undefined ? '—' : formatMib(imp.ramMib)}
              {' / '}
              {formatMib(imp.memoryMib)}
            </td>
            <td className={styles['numeric']}>{formatCpuUse(imp)}</td>
            <td>{formatRelativeTime(imp.lastActiveAt, props.nowMs)}</td>
            <td>
              <a href={imp.url} target="_blank" rel="noreferrer">
                {new URL(imp.url).host}
              </a>
            </td>
            <td>
              <ImpActions imp={imp} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
