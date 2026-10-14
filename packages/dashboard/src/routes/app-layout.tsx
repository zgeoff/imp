import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { Button } from '../components/button';
import { ErrorText } from '../components/error-text';
import { useImpd } from '../lib/impd';
import { LIVE, SLOW } from '../lib/live';
import { sendLogout } from '../lib/session';
import { useImpdEvents } from '../lib/use-impd-events';
import styles from './app-layout.module.css';

export function AppLayout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const impd = useImpd();

  // tokens are for a caller that manages the whole host; impd checks too
  const identity = useQuery({ ...impd.query.tokens.whoami.queryOptions(), ...SLOW });
  const managesHost = identity.data?.scope === 'manage' && identity.data.imps === null;

  // a host-wide state every page shows, such as a reboot a kernel oops needs
  const info = useQuery({ ...impd.query.system.info.queryOptions(), ...LIVE });
  const rebootReason = info.data?.rebootReason ?? null;

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
        {managesHost && (
          <Link to="/tokens" activeProps={{ className: styles['active'] }}>
            Tokens
          </Link>
        )}
        <div className={styles['session']}>
          {identity.data !== undefined && (
            <span className={styles['identity']}>
              {identity.data.name} ({identity.data.scope})
            </span>
          )}
          <Button
            disabled={logout.isPending}
            onClick={() => {
              logout.mutate();
            }}
          >
            Log out
          </Button>
        </div>
      </nav>
      {rebootReason !== null && (
        <p className={styles['warning']} role="alert">
          host needs a reboot: {rebootReason}
        </p>
      )}
      <ErrorText error={logout.error} />
      <main className={styles['main']}>
        <Outlet />
      </main>
    </div>
  );
}
