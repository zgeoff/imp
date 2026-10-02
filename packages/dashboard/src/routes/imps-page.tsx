import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../components/button';
import { CreateImpDialog } from '../components/create-imp-dialog';
import { ErrorText } from '../components/error-text';
import { ImpTable } from '../components/imp-table';
import { RamMeter } from '../components/ram-meter';
import { useImpd } from '../lib/impd';
import { LIVE } from '../lib/live';
import { useNow } from '../lib/use-now';
import styles from './page.module.css';

export function ImpsPage() {
  const impd = useImpd();
  const nowMs = useNow();
  const [creating, setCreating] = useState(false);
  const imps = useQuery({ ...impd.query.imps.list.queryOptions(), ...LIVE });
  const info = useQuery({ ...impd.query.system.info.queryOptions(), ...LIVE });

  return (
    <div className={styles['page']}>
      <header className={styles['header']}>
        <h1>Imps</h1>
        <Button
          tone="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          New imp
        </Button>
      </header>
      {info.data !== undefined && (
        <section className={styles['card']}>
          <RamMeter info={info.data} />
        </section>
      )}
      <ErrorText error={imps.error} />
      {imps.data !== undefined && imps.data.length === 0 && (
        <p className={styles['empty']}>No imps yet. Make one with New imp.</p>
      )}
      {imps.data !== undefined && imps.data.length > 0 && (
        <ImpTable imps={imps.data} nowMs={nowMs} />
      )}
      <CreateImpDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
