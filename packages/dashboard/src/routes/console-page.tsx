import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import { ConsoleView } from '../components/console/console-view';
import { createConsoleSource } from '../components/console/create-console-source';
import { useImpd } from '../lib/impd';
import styles from './page.module.css';

interface ConsolePageProps {
  readonly name: string;
}

export function ConsolePage(props: ConsolePageProps) {
  const impd = useImpd();
  const source = useMemo(() => createConsoleSource(impd.client, props.name), [impd, props.name]);

  return (
    <div className={`${styles['page'] ?? ''} ${styles['full'] ?? ''}`}>
      <header className={styles['header']}>
        <h1>{props.name}</h1>
        <Link to="/imps/$name" params={{ name: props.name }}>
          Details
        </Link>
      </header>
      <ConsoleView source={source} />
    </div>
  );
}
