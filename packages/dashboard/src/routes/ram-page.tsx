import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Imp } from '@zgeoff/imp-client';
import { ErrorText } from '../components/error-text';
import { RamMeter } from '../components/ram-meter';
import { StateBadge } from '../components/state-badge';
import tableStyles from '../components/table.module.css';
import { formatMib } from '../lib/format';
import { useImpd } from '../lib/impd';
import { LIVE } from '../lib/live';
import styles from './page.module.css';

// The budget and what each awake imp holds. The governor's decisions are
// not in the API yet; they come with the event stream (#38).
export function RamPage() {
  const impd = useImpd();
  const info = useQuery({ ...impd.query.system.info.queryOptions(), ...LIVE });
  const imps = useQuery({ ...impd.query.imps.list.queryOptions(), ...LIVE });
  const awake = sortByRam(imps.data ?? []);

  return (
    <div className={styles['page']}>
      <header className={styles['header']}>
        <h1>RAM</h1>
      </header>
      <ErrorText error={info.error ?? imps.error} />
      {info.data !== undefined && (
        <section className={styles['card']}>
          <RamMeter info={info.data} />
        </section>
      )}
      <table className={tableStyles['table']}>
        <thead>
          <tr>
            <th>Imp</th>
            <th>State</th>
            <th className={tableStyles['numeric']}>Owned</th>
            <th className={tableStyles['numeric']}>Resident</th>
            <th className={tableStyles['numeric']}>Memory</th>
          </tr>
        </thead>
        <tbody>
          {awake.map((imp) => (
            <tr key={imp.id}>
              <td>
                <Link to="/imps/$name" params={{ name: imp.name }}>
                  {imp.name}
                </Link>
              </td>
              <td>
                <StateBadge state={imp.state} />
              </td>
              <td className={tableStyles['numeric']}>{formatOptionalMib(imp.ramMib)}</td>
              <td className={tableStyles['numeric']}>{formatOptionalMib(imp.rssMib)}</td>
              <td className={tableStyles['numeric']}>{formatMib(imp.memoryMib)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// the imps holding the most RAM first; imps that are not awake hold none
function sortByRam(imps: readonly Imp[]): Imp[] {
  return imps.toSorted((first, second) => (second.ramMib ?? -1) - (first.ramMib ?? -1));
}

function formatOptionalMib(mib: number | undefined): string {
  return mib === undefined ? '—' : formatMib(mib);
}
