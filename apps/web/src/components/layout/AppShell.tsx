import * as RadixDialog from '@radix-ui/react-dialog';
import { Outlet, useRouterState } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.js';
import { useOrg } from '../../lib/org.js';
import { Card } from '../primitives/Card.js';
import { Skeleton } from '../primitives/Skeleton.js';
import { DevAuthBar } from './DevAuthBar.js';
import { Sidebar } from './Sidebar.js';

/** Pre-auth / pre-org gate screens keep the shell simple: no sidebar until an org context exists. */
function ConnectGate() {
  return (
    <div className="spillway-band flex flex-1 items-center justify-center p-6">
      <Card padding="lg" className="relative max-w-md text-center">
        <div className="flex items-center justify-center gap-2 font-mono text-[12px] font-semibold tracking-[0.18em]">
          <span aria-hidden className="size-2 rounded-full bg-[var(--blue)]" />
          SPILLWAY
        </div>
        <div className="brand-serif mt-3 text-[28px] leading-tight">
          The console for <em>governed</em> spend.
        </div>
        <p className="mt-2.5 text-sm text-[var(--ink-mut)]">
          Run <code className="font-mono text-[12px]">pnpm dev:token</code> in the repo, then paste
          the JWT and org id into the bar above. WorkOS AuthKit login replaces this seam in
          production.
        </p>
      </Card>
    </div>
  );
}

/** Below lg the sidebar collapses to this bar + a slide-over (Radix Dialog owns focus/escape). */
function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Route change means a nav click landed — close the sheet.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-warm)] px-4 py-2.5 lg:hidden">
      <RadixDialog.Root open={open} onOpenChange={setOpen}>
        <RadixDialog.Trigger
          aria-label="Open navigation"
          className="focus-ring rounded-[var(--radius-btn)] p-1.5 text-[var(--ink-read)]"
        >
          <Menu size={18} aria-hidden />
        </RadixDialog.Trigger>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fixed inset-0 z-40 bg-[rgba(11,18,32,0.32)] data-[state=open]:animate-[fade-in_200ms_var(--ease-big)]" />
          <RadixDialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex outline-none data-[state=open]:animate-[drawer-in-left_240ms_var(--ease-big)]"
          >
            <RadixDialog.Title className="sr-only">Navigation</RadixDialog.Title>
            <Sidebar />
            <RadixDialog.Close
              aria-label="Close navigation"
              className="focus-ring m-2 h-fit rounded-[var(--radius-btn)] bg-[var(--card)] p-1.5 text-[var(--ink-mut)] shadow-[var(--shadow-pop)]"
            >
              <X size={16} aria-hidden />
            </RadixDialog.Close>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
      <span className="font-mono text-[13px] font-semibold tracking-[0.18em]">SPILLWAY</span>
    </div>
  );
}

/** Root layout: dev-auth strip, responsive sidebar, scrollable main. */
export function AppShell() {
  const { session, activeOrgId } = useAuth();
  const { loading } = useOrg();

  return (
    <div className="flex h-full flex-col">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <DevAuthBar />
      {session && activeOrgId ? <MobileNav /> : null}
      <div className="flex min-h-0 flex-1">
        {session && activeOrgId ? (
          <>
            <div className="hidden lg:flex">
              <Sidebar />
            </div>
            <main id="main-content" className="min-w-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-[1200px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
                {loading ? (
                  <div className="flex flex-col gap-4">
                    <Skeleton className="h-8 w-64" />
                    <Skeleton className="h-40 w-full" />
                  </div>
                ) : (
                  <Outlet />
                )}
              </div>
            </main>
          </>
        ) : (
          <ConnectGate />
        )}
      </div>
    </div>
  );
}
