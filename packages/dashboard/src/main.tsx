import './styles/global.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { buildQueryClient } from './lib/build-query-client';
import { ImpdProvider, createBrowserImpd } from './lib/impd';
import { buildRouter } from './router';

const impd = createBrowserImpd(globalThis.location.origin);

const queryClient = buildQueryClient(() => {
  void router.navigate({ to: '/login' });
});

const router = buildRouter();
const root = document.querySelector('#root');

if (root === null) {
  throw new Error('index.html has no #root');
}

createRoot(root).render(
  <StrictMode>
    <ImpdProvider impd={impd}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ImpdProvider>
  </StrictMode>,
);
