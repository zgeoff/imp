import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { Button } from '../components/button';
import { ErrorText } from '../components/error-text';
import { sendLogout } from '../lib/session';
import { useImpdEvents } from '../lib/use-impd-events';
import styles from './app-layout.module.css';

export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useImpdEvents();

  // the next person at this browser must not see the last one's imps
  const logout = useMutation({
    mutationFn: sendLogout,
    onSuccess: async () => {
      await navigate({ to: '/login' });

      queryClient.clear();
    },
  });

  return (
    <div className={styles['layout']}>
      <nav className={styles['nav']}>
        <span className={styles['brand']}>imp</span>
        <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: styles['active'] }}>
          Imps
        </Link>
        <Link to="/images" activeProps={{ className: styles['active'] }}>
          Images
        </Link>
        <Link to="/ram" activeProps={{ className: styles['active'] }}>
          RAM
        </Link>
        <Button
          disabled={logout.isPending}
          onClick={() => {
            logout.mutate();
          }}
        >
          Log out
        </Button>
      </nav>
      <ErrorText error={logout.error} />
      <main className={styles['main']}>
        <Outlet />
      </main>
    </div>
  );
}
