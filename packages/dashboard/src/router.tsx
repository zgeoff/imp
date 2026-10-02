import type { RouterHistory } from '@tanstack/react-router';
import { Outlet, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { lazy } from 'react';
import { AppLayout } from './routes/app-layout';
import { ImagesPage } from './routes/images-page';
import { ImpPage } from './routes/imp-page';
import { ImpsPage } from './routes/imps-page';
import { LoginPage } from './routes/login-page';
import { RamPage } from './routes/ram-page';

// Routes in code: seven of them need no generator. impd serves the app
// under /ui/ (packages/daemon dashboard-files.ts).
// xterm.js is most of the bundle; only the console needs it
const ConsolePage = lazy(async () => {
  const module = await import('./routes/console-page');

  return { default: module.ConsolePage };
});

const rootRoute = createRootRoute({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AppLayout,
});

const impsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: ImpsPage,
});

const impRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/imps/$name',
  component: ImpRouteView,
});

const consoleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/imps/$name/console',
  component: ConsoleRouteView,
});

const imagesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/images',
  component: ImagesPage,
});

const ramRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/ram',
  component: RamPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([impsRoute, impRoute, consoleRoute, imagesRoute, ramRoute]),
]);

// keyed by name, so a page for another imp starts fresh
function ImpRouteView() {
  const params = impRoute.useParams();

  return <ImpPage key={params.name} name={params.name} />;
}

function ConsoleRouteView() {
  const params = consoleRoute.useParams();

  return <ConsolePage key={params.name} name={params.name} />;
}

// tests pass a memory history
export function buildRouter(history?: RouterHistory) {
  return createRouter({ routeTree, basepath: '/ui', ...(history !== undefined && { history }) });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>;
  }
}
