import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { buildQueryClient } from '../lib/build-query-client';
import { ImpdProvider } from '../lib/impd';
import { buildRouter } from '../router';
import type { StubImpd } from './build-stub-impd';

// The whole app at `path` (under /ui), against a stub impd, with the router
// and query client beside the render result
export function renderApp(stub: StubImpd, path = '/') {
  const router = buildRouter(createMemoryHistory({ initialEntries: [`/ui${path}`] }));

  const queryClient = buildQueryClient(() => {
    void router.navigate({ to: '/login' });
  });

  const rendered = render(
    <ImpdProvider impd={stub.impd}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ImpdProvider>,
  );

  return { ...rendered, router, queryClient };
}
