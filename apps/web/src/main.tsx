import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import { TooltipProvider } from './components/primitives/Tooltip.js';
import { AuthProvider } from './lib/auth.js';
import { OrgProvider } from './lib/org.js';
import { queryClient } from './lib/query.js';
import { router } from './router.js';
import './styles/globals.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <OrgProvider>
          <TooltipProvider delayDuration={300}>
            <RouterProvider router={router} />
            <Toaster
              position="bottom-right"
              toastOptions={{
                style: {
                  background: 'var(--card)',
                  color: 'var(--ink)',
                  border: '1px solid var(--line-strong)',
                  borderRadius: 'var(--radius-btn)',
                  fontSize: '13px',
                },
              }}
            />
          </TooltipProvider>
        </OrgProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
