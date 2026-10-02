import '@xterm/xterm/css/xterm.css';
import { useNavigate } from '@tanstack/react-router';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import { isUnauthorized } from '../../lib/build-query-client';
import { Button } from '../button';
import styles from './console-view.module.css';
import { setupTerminalBridge } from './setup-terminal-bridge';
import type { TerminalEnd, TerminalSource } from './terminal-source';

type Status =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'open' }
  | { readonly kind: 'ended'; readonly end: TerminalEnd };

interface ConsoleViewProps {
  // keep it stable across renders (useMemo): a new source reconnects
  readonly source: TerminalSource;
}

export function ConsoleView(props: ConsoleViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    const element = container.current;

    // the screen element renders with the view, before any effect runs
    if (element === null) {
      throw new Error('the console has no screen element');
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 14,
      theme: { background: '#0d1117', foreground: '#e6edf3' },
    });

    const fit = new FitAddon();
    const abort = new AbortController();

    const cleanups: (() => void)[] = [];

    terminal.loadAddon(fit);
    terminal.open(element);
    fit.fit();
    terminal.focus();

    const observer = new ResizeObserver(() => {
      fit.fit();
    });

    observer.observe(element);

    setStatus({ kind: 'connecting' });

    const startConnection = async (): Promise<void> => {
      try {
        const size = { cols: terminal.cols, rows: terminal.rows };

        const connection = await props.source.open(size, abort.signal);

        cleanups.push(setupTerminalBridge(terminal, connection), connection.close);

        setStatus({ kind: 'open' });

        const end = await connection.ended;

        if (!abort.signal.aborted) {
          setStatus({ kind: 'ended', end });
        }
      } catch (error) {
        // the session ended: the ticket call got impd's 401
        if (isUnauthorized(error)) {
          await navigate({ to: '/login' });

          return;
        }

        if (!abort.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);

          setStatus({ kind: 'ended', end: { kind: 'error', message } });
        }
      }
    };

    void startConnection();

    return () => {
      abort.abort();
      observer.disconnect();

      for (const cleanup of cleanups) {
        cleanup();
      }

      terminal.dispose();
    };
  }, [props.source, attempt, navigate]);

  return (
    <div className={styles['console']}>
      <div className={styles['bar']}>
        <span>{props.source.label}</span>
        <span className={styles['status']} role="status">
          {formatStatus(status)}
        </span>
        {status.kind === 'ended' && (
          <Button
            onClick={() => {
              setAttempt((previous) => previous + 1);
            }}
          >
            Reconnect
          </Button>
        )}
      </div>
      <div className={styles['screen']} ref={container} data-testid="console-screen" />
    </div>
  );
}

function formatStatus(status: Status): string {
  if (status.kind === 'connecting') {
    return 'connecting…';
  }

  if (status.kind === 'open') {
    return 'connected';
  }

  const end = status.end;

  if (end.kind === 'error') {
    return `disconnected: ${end.message}`;
  }

  return end.signal === null ? `exited with code ${String(end.code)}` : `ended by ${end.signal}`;
}
