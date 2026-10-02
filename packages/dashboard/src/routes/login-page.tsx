import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '../components/button';
import formStyles from '../components/form.module.css';
import { readText } from '../lib/read-form';
import { sendLogin } from '../lib/session';
import styles from './login-page.module.css';

const MESSAGES = {
  'wrong-token': 'impd knows no such token.',
  failed: 'impd did not answer the login.',
} as const;

// The token goes to impd once, which answers with the session cookie
export function LoginPage() {
  const navigate = useNavigate();

  const login = useMutation({
    mutationFn: sendLogin,
    onSuccess: async (result) => {
      if (result === 'ok') {
        await navigate({ to: '/' });
      }
    },
  });

  const result = login.data;

  return (
    <main className={styles['login']}>
      <form
        className={`${styles['card'] ?? ''} ${formStyles['form'] ?? ''}`}
        onSubmit={(event) => {
          event.preventDefault();

          const token = readText(new FormData(event.currentTarget), 'token');

          if (token !== undefined) {
            login.mutate(token);
          }
        }}
      >
        <h1>imp</h1>
        <label className={formStyles['field']}>
          API token
          <input name="token" type="password" required autoComplete="current-password" />
        </label>
        <p className={styles['hint']}>
          The root token is in <code>/var/lib/imp/token</code> on the host, or{' '}
          <code>scripts/dev.sh token</code> for a dev instance. A token from{' '}
          <code>imp token new</code> works too, with its scope.
        </p>
        {result !== undefined && result !== 'ok' && (
          <p className={styles['error']} role="alert">
            {MESSAGES[result]}
          </p>
        )}
        {login.error !== null && (
          <p className={styles['error']} role="alert">
            {login.error.message}
          </p>
        )}
        <Button tone="primary" type="submit" disabled={login.isPending}>
          Log in
        </Button>
      </form>
    </main>
  );
}
