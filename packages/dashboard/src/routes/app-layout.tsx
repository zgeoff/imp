import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { Button } from '../components/button';
import { sendLogout } from '../lib/session';
import styles from './app-layout.module.css';

export function AppLayout() {
  const navigate = useNavigate();

  const runLogout = async (): Promise<void> => {
    await sendLogout();
    await navigate({ to: '/login' });
  };

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
          onClick={() => {
            void runLogout();
          }}
        >
          Log out
        </Button>
      </nav>
      <main className={styles['main']}>
        <Outlet />
      </main>
    </div>
  );
}
