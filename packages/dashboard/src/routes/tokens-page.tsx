import { useMutation, useQuery } from '@tanstack/react-query';
import type { Scope, Token } from '@zgeoff/imp-client';
import { useState } from 'react';
import { Button } from '../components/button';
import { ConfirmDialog } from '../components/confirm-dialog';
import { ErrorText } from '../components/error-text';
import formStyles from '../components/form.module.css';
import tableStyles from '../components/table.module.css';
import { formatRelativeTime } from '../lib/format';
import { useImpd } from '../lib/impd';
import { SLOW } from '../lib/live';
import { readText } from '../lib/read-form';
import { useNow } from '../lib/use-now';
import { useRefresh } from '../lib/use-refresh';
import styles from './page.module.css';

const SCOPES: readonly Scope[] = ['read', 'exec', 'manage'];

// a made token's secret, shown until the page is left: impd keeps a hash
interface MadeToken {
  readonly name: string;
  readonly secret: string;
}

export function TokensPage() {
  const impd = useImpd();
  const nowMs = useNow();
  const refresh = useRefresh();
  const [made, setMade] = useState<MadeToken | null>(null);
  const [removing, setRemoving] = useState<Token | null>(null);
  const tokens = useQuery({ ...impd.query.tokens.list.queryOptions(), ...SLOW });

  const create = useMutation({
    mutationFn: (form: FormData) => {
      const imps = readImpPatterns(form);

      return impd.client.tokens.create({
        name: readText(form, 'name') ?? '',
        scope: readScope(form),
        ...(imps.length > 0 && { imps }),
      });
    },
    onSuccess: (result) => {
      setMade({ name: result.token.name, secret: result.secret });
    },
    onSettled: refresh,
  });

  return (
    <div className={styles['page']}>
      <header className={styles['header']}>
        <h1>Tokens</h1>
      </header>
      <form
        className={`${styles['card'] ?? ''} ${formStyles['form'] ?? ''}`}
        onSubmit={(event) => {
          event.preventDefault();

          const form = event.currentTarget;

          create.mutate(new FormData(form), {
            onSuccess: () => {
              form.reset();
            },
          });
        }}
      >
        <div className={formStyles['row']}>
          <label className={formStyles['field']}>
            Name
            <input name="name" required placeholder="ci" autoComplete="off" />
          </label>
          <label className={formStyles['field']}>
            Scope
            <select name="scope" defaultValue="read">
              {SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {scope}
                </option>
              ))}
            </select>
          </label>
          <label className={formStyles['field']}>
            Imps
            <input name="imps" placeholder="every imp, or dev-*, ci-*" autoComplete="off" />
          </label>
        </div>
        <ErrorText error={create.error} />
        <div className={formStyles['actions']}>
          <Button tone="primary" type="submit" disabled={create.isPending}>
            Make token
          </Button>
        </div>
      </form>
      {made !== null && <MadeTokenCard made={made} />}
      <ErrorText error={tokens.error} />
      {tokens.data !== undefined && (
        <table className={tableStyles['table']}>
          <thead>
            <tr>
              <th>Token</th>
              <th>Scope</th>
              <th>Imps</th>
              <th>Made</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {tokens.data.map((token) => (
              <tr key={token.name}>
                <td>{token.name}</td>
                <td>{token.scope}</td>
                <td>{token.imps === null ? 'every imp' : token.imps.join(', ')}</td>
                <td>{formatRelativeTime(token.createdAt, nowMs)}</td>
                <td className={tableStyles['actions']}>
                  <Button
                    tone="danger"
                    onClick={() => {
                      setRemoving(token);
                    }}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {removing !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRemoving(null);
            }
          }}
          title={`Delete ${removing.name}?`}
          description="Its sessions, streams and sockets end at once."
          confirmLabel="Delete"
          onConfirm={async () => {
            await impd.client.tokens.delete({ name: removing.name });

            await refresh();
          }}
        />
      )}
    </div>
  );
}

interface MadeTokenCardProps {
  readonly made: MadeToken;
}

function MadeTokenCard(props: MadeTokenCardProps) {
  const copy = useMutation({
    mutationFn: () => navigator.clipboard.writeText(props.made.secret),
  });

  return (
    <section className={styles['card']} aria-label={`Secret of ${props.made.name}`}>
      <p>
        The secret of <strong>{props.made.name}</strong>. impd shows it only this once.
      </p>
      <code>{props.made.secret}</code>
      <ErrorText error={copy.error} />
      <div className={formStyles['actions']}>
        <Button
          onClick={() => {
            copy.mutate();
          }}
        >
          {copy.isSuccess ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </section>
  );
}

function readScope(form: FormData): Scope {
  const scope = readText(form, 'scope');

  return SCOPES.find((each) => each === scope) ?? 'read';
}

// `dev-*, ci-*` as a list; empty for every imp
function readImpPatterns(form: FormData): string[] {
  return (readText(form, 'imps') ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');
}
