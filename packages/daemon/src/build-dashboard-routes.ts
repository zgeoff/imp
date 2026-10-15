import { Elysia } from 'elysia';
import { createSessionRoutes } from './auth/session-routes';
import type { SessionRouteDeps } from './auth/session-routes';
import { DASHBOARD_PATH, createDashboardFiles } from './dashboard/dashboard-files';

interface DashboardRouteDeps extends SessionRouteDeps {
  // the built dashboard's files; null serves none
  readonly dashboardDir: string | null;
}

// What a browser on the dashboard calls besides /rpc: the login that sets
// its session cookie, the logout that clears it, and the app's files
export function buildDashboardRoutes(deps: DashboardRouteDeps) {
  const sessionRoutes = createSessionRoutes(deps);
  const dashboard = createDashboardFiles(deps.dashboardDir);

  return (
    new Elysia()
      .post('/auth/login', (context) => sessionRoutes.login(context.request), { parse: 'none' })
      .post('/auth/logout', (context) => sessionRoutes.logout(context.request), { parse: 'none' })

      // under its own prefix, so no dashboard route can shadow the API's
      .get('/', () => Response.redirect(DASHBOARD_PATH, 302))
      .get(DASHBOARD_PATH, (context) => dashboard.serve(context.request))
      .get(`${DASHBOARD_PATH}*`, (context) => dashboard.serve(context.request))
  );
}
