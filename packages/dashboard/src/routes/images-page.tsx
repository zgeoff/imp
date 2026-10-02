import { useMutation, useQuery } from '@tanstack/react-query';
import type { Image } from '@zgeoff/imp-client';
import { useState } from 'react';
import { Button } from '../components/button';
import { ConfirmDialog } from '../components/confirm-dialog';
import { ErrorText } from '../components/error-text';
import formStyles from '../components/form.module.css';
import tableStyles from '../components/table.module.css';
import { formatBytes, formatRelativeTime } from '../lib/format';
import { useImpd } from '../lib/impd';
import { SLOW } from '../lib/live';
import { readText } from '../lib/read-form';
import { useNow } from '../lib/use-now';
import { useRefresh } from '../lib/use-refresh';
import styles from './page.module.css';

export function ImagesPage() {
  const impd = useImpd();
  const nowMs = useNow();
  const refresh = useRefresh();
  const [removing, setRemoving] = useState<Image | null>(null);
  const images = useQuery({ ...impd.query.images.list.queryOptions(), ...SLOW });

  const add = useMutation({
    mutationFn: (form: FormData) => {
      const name = readText(form, 'name');

      return impd.client.images.add({
        ref: readText(form, 'ref') ?? '',
        ...(name !== undefined && { name }),
      });
    },
    onSettled: refresh,
  });

  return (
    <div className={styles['page']}>
      <header className={styles['header']}>
        <h1>Images</h1>
      </header>
      <form
        className={`${styles['card'] ?? ''} ${formStyles['form'] ?? ''}`}
        onSubmit={(event) => {
          event.preventDefault();

          const form = event.currentTarget;

          add.mutate(new FormData(form), {
            onSuccess: () => {
              form.reset();
            },
          });
        }}
      >
        <div className={formStyles['row']}>
          <label className={formStyles['field']}>
            Image ref
            <input name="ref" required placeholder="docker.io/library/node:22" />
          </label>
          <label className={formStyles['field']}>
            Name
            <input name="name" placeholder="from the ref" />
          </label>
        </div>
        <ErrorText error={add.error} />
        <div className={formStyles['actions']}>
          <Button tone="primary" type="submit" disabled={add.isPending}>
            {add.isPending ? 'Pulling and unpacking…' : 'Add image'}
          </Button>
        </div>
      </form>
      <ErrorText error={images.error} />
      {images.data !== undefined && (
        <table className={tableStyles['table']}>
          <thead>
            <tr>
              <th>Image</th>
              <th>Ref</th>
              <th className={tableStyles['numeric']}>Size</th>
              <th>Added</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {images.data.map((image) => (
              <tr key={image.id}>
                <td>{image.name}</td>
                <td>
                  <code>{image.ref}</code>
                </td>
                <td className={tableStyles['numeric']}>{formatBytes(image.sizeBytes)}</td>
                <td>{formatRelativeTime(image.createdAt, nowMs)}</td>
                <td className={tableStyles['actions']}>
                  <Button
                    tone="danger"
                    onClick={() => {
                      setRemoving(image);
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
          description="impd refuses while an imp uses it."
          confirmLabel="Delete"
          onConfirm={async () => {
            await impd.client.images.delete({ name: removing.name });

            await refresh();
          }}
        />
      )}
    </div>
  );
}
