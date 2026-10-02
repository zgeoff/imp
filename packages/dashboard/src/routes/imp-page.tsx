import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Imp } from '@zgeoff/imp-client';
import { useState } from 'react';
import { Button } from '../components/button';
import { CheckpointsPanel } from '../components/checkpoints-panel';
import { ErrorText } from '../components/error-text';
import { ForkDialog } from '../components/fork-dialog';
import { ImpActions } from '../components/imp-actions';
import { ImpNotes } from '../components/imp-notes';
import { StateBadge } from '../components/state-badge';
import { formatMib, formatRelativeTime } from '../lib/format';
import { useImpd } from '../lib/impd';
import { LIVE, SLOW } from '../lib/live';
import { useNow } from '../lib/use-now';
import styles from './page.module.css';

interface ImpPageProps {
  readonly name: string;
}

export function ImpPage(props: ImpPageProps) {
  const impd = useImpd();
  const nowMs = useNow();
  const [forking, setForking] = useState(false);

  const imp = useQuery({
    ...impd.query.imps.get.queryOptions({ input: { name: props.name } }),
    ...LIVE,
  });

  if (imp.data === undefined) {
    return (
      <div className={styles['page']}>
        <Link to="/">All imps</Link>
        {imp.isPending && <p className={styles['empty']}>Loading…</p>}
        <ErrorText error={imp.error} />
      </div>
    );
  }

  return (
    <div className={styles['page']}>
      <header className={styles['header']}>
        <h1>{imp.data.name}</h1>
        <StateBadge state={imp.data.state} />
        <div>
          <Button
            onClick={() => {
              setForking(true);
            }}
          >
            Fork
          </Button>
        </div>
      </header>
      <ImpActions imp={imp.data} afterDestroy="/" />
      <ImpNotes imp={imp.data} nowMs={nowMs} />
      <section className={styles['card']}>
        <ImpDetails imp={imp.data} nowMs={nowMs} />
      </section>
      <CheckpointsPanel name={props.name} nowMs={nowMs} />
      <ForkDialog open={forking} onOpenChange={setForking} source={props.name} />
    </div>
  );
}

interface ImpDetailsProps {
  readonly imp: Imp;
  readonly nowMs: number;
}

function ImpDetails(props: ImpDetailsProps) {
  const impd = useImpd();
  const imp = props.imp;

  const urls = useQuery({
    ...impd.query.imps.url.queryOptions({ input: { name: imp.name } }),
    ...SLOW,
  });

  return (
    <dl className={styles['details']}>
      <dt>Image</dt>
      <dd>{imp.image}</dd>
      <dt>Size</dt>
      <dd>
        {imp.vcpus} vCPU, {formatMib(imp.memoryMib)}
      </dd>
      <dt>RAM now</dt>
      <dd>
        {imp.ramMib === undefined ? 'not awake' : `${formatMib(imp.ramMib)} owned`}
        {imp.rssMib !== undefined && `, ${formatMib(imp.rssMib)} resident`}
      </dd>
      <dt>URL</dt>
      <dd>
        <a href={imp.url} target="_blank" rel="noreferrer">
          {imp.url}
        </a>
        {urls.data?.tailnet !== undefined && urls.data.tailnet !== null && (
          <>
            {' · '}
            <a href={urls.data.tailnet} target="_blank" rel="noreferrer">
              {urls.data.tailnet}
            </a>
          </>
        )}
      </dd>
      <dt>Address</dt>
      <dd>
        <code>{imp.ip}</code>, HTTP port {imp.httpPort}
      </dd>
      <dt>Created</dt>
      <dd>{formatRelativeTime(imp.createdAt, props.nowMs)}</dd>
      <dt>Last active</dt>
      <dd>{formatRelativeTime(imp.lastActiveAt, props.nowMs)}</dd>
      {imp.sleptAt !== undefined && (
        <>
          <dt>Asleep since</dt>
          <dd>{formatRelativeTime(imp.sleptAt, props.nowMs)}</dd>
        </>
      )}
    </dl>
  );
}
