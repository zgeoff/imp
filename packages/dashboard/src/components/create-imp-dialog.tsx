import { useMutation, useQuery } from '@tanstack/react-query';
import { useImpd } from '../lib/impd';
import { readInteger, readText } from '../lib/read-form';
import { useRefresh } from '../lib/use-refresh';
import { Button } from './button';
import { ErrorText } from './error-text';
import styles from './form.module.css';
import { Modal } from './modal';

interface CreateImpDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

// Blank fields take impd's defaults (IMP_DEFAULT_IMAGE, …), as `imp new` does.
export function CreateImpDialog(props: CreateImpDialogProps) {
  const impd = useImpd();
  const refresh = useRefresh();
  const images = useQuery({ ...impd.query.images.list.queryOptions(), enabled: props.open });

  const create = useMutation({
    mutationFn: (form: FormData) => impd.client.imps.create(readCreateInput(form)),
    onSuccess: async () => {
      await refresh();

      props.onOpenChange(false);
    },
  });

  return (
    <Modal
      open={props.open}
      onOpenChange={(open) => {
        create.reset();
        props.onOpenChange(open);
      }}
      title="New imp"
      description="Blank fields take impd's defaults."
    >
      <form
        className={styles['form']}
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate(new FormData(event.currentTarget));
        }}
      >
        <label className={styles['field']}>
          Name
          <input name="name" placeholder="a random name" autoComplete="off" />
        </label>
        <label className={styles['field']}>
          Image
          <select name="image" defaultValue="">
            <option value="">default</option>
            {images.data?.map((image) => (
              <option key={image.id} value={image.name}>
                {image.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles['row']}>
          <label className={styles['field']}>
            Memory (MiB)
            <input name="memoryMib" type="number" min={128} step={128} />
          </label>
          <label className={styles['field']}>
            vCPUs
            <input name="vcpus" type="number" min={1} max={32} />
          </label>
          <label className={styles['field']}>
            HTTP port
            <input name="httpPort" type="number" min={1} max={65_535} placeholder="8080" />
          </label>
        </div>
        <ErrorText error={create.error} />
        <div className={styles['actions']}>
          <Button
            onClick={() => {
              props.onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button tone="primary" type="submit" disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// blank fields are left out; exactOptionalPropertyTypes refuses undefined
function readCreateInput(form: FormData) {
  const name = readText(form, 'name');
  const image = readText(form, 'image');
  const memoryMib = readInteger(form, 'memoryMib');
  const vcpus = readInteger(form, 'vcpus');
  const httpPort = readInteger(form, 'httpPort');

  return {
    ...(name !== undefined && { name }),
    ...(image !== undefined && { image }),
    ...(memoryMib !== undefined && { memoryMib }),
    ...(vcpus !== undefined && { vcpus }),
    ...(httpPort !== undefined && { httpPort }),
  };
}
