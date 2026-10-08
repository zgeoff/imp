import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { buildQueryClient } from '../lib/build-query-client';
import { ImpdProvider, createBrowserImpd } from '../lib/impd';
import { IMPD_ORIGIN } from '../mocks/handlers';
import { buildRouter } from '../router';

// The whole app at `path` (under /ui), as the browser runs it from impd:
// the SDK calls impd's origin, where the MSW handlers answer. The router and
// query client come beside the render result.
export function renderApp(path = '/') {
  const router = buildRouter(createMemoryHistory({ initialEntries: [`/ui${path}`] }));

  const queryClient = buildQueryClient(() => {
    void router.navigate({ to: '/login' });
  });

  const rendered = render(
    <ImpdProvider impd={createBrowserImpd(IMPD_ORIGIN)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ImpdProvider>,
  );

  return { ...rendered, router, queryClient };
}
