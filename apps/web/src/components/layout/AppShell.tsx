import * as RadixDialog from '@radix-ui/react-dialog';
import { Outlet, useMatchRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.js';
import { useOrg } from '../../lib/org.js';
import { resolveAppGate } from '../../lib/app-gate.js';
import { Button } from '../primitives/Button.js';
import { Card } from '../primitives/Card.js';
import { Skeleton } from '../primitives/Skeleton.js';
import { DevAuthBar } from './DevAuthBar.js';
import { Sidebar } from './Sidebar.js';

/** Pre-auth / pre-org gate screens keep the shell simple: no sidebar until an org context exists. */
function ConnectGate() {
  const { signIn } = useAuth();
  const isDev = typeof import.meta.env !== 'undefined' && import.meta.env.DEV;

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
          Sign in to set budgets, issue virtual keys, and watch spend get governed in the request
          path.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2.5">
          <Button onClick={() => signIn({ signUp: true })}>Create an account</Button>
          <Button variant="ghost" onClick={() => signIn()}>
            Sign in
          </Button>
        </div>
        {isDev ? (
          <p className="mt-4 text-[12px] text-[var(--ink-mut)]">
            No WorkOS locally? Run <code className="font-mono text-[11px]">pnpm dev:token</code> and
            paste the JWT + org id into the bar above.
          </p>
        ) : null}
      </Card>
    </div>
  );
}

/**
 * Covers both auth bootstrap and org-membership bootstrap: neither "no token yet" nor "orgs not
 * fetched yet" may render as a dead end (signed-out gate or, worse, onboarding for a user who
 * turns out to have orgs) — see resolveAppGate's 'auth-loading' / 'org-loading' states.
 */
function AuthLoading() {
  return (
    <div className="spillway-band flex flex-1 items-center justify-center p-6">
      <Card padding="lg" className="max-w-md text-center">
        <Skeleton className="mx-auto h-5 w-40" />
        <Skeleton className="mx-auto mt-3 h-8 w-64" />
        <span className="sr-only">Loading…</span>
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

/**
 * The membership fetch failed, so the org count is UNKNOWN. It must not fall through to the
 * onboarding gate: telling a user with existing orgs to "create your first organization" because
 * one request failed is both alarming and destructive (the repair effect would otherwise clear
 * their stored org). Offer a retry and claim nothing about how many orgs they have.
 */
function OrgLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="spillway-band flex flex-1 items-center justify-center p-6">
      <Card padding="lg" className="max-w-md text-center">
        <div className="brand-serif text-[24px] leading-tight">
          Couldn&rsquo;t load your workspace
        </div>
        <p className="mt-2.5 text-sm text-[var(--ink-mut)]">
          We couldn&rsquo;t reach the API to look up your organizations. Nothing is lost — this is a
          connection problem.
        </p>
        <div className="mt-5 flex items-center justify-center">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      </Card>
    </div>
  );
}

/** Root layout: dev-auth strip, responsive sidebar, scrollable main. */
export function AppShell() {
  const { status } = useAuth();
  const { orgs, activeOrg, loading: orgsLoading, error: orgsError, retry: retryOrgs } = useOrg();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const isDev = typeof import.meta.env !== 'undefined' && import.meta.env.DEV;

  const gate = resolveAppGate({
    authStatus: status,
    orgsLoading,
    orgsError,
    orgCount: orgs.length,
  });
  const onOnboardingRoute = !!matchRoute({ to: '/onboarding' });

  // A zero-org user must land in onboarding no matter where they are — except when they're
  // already there, or this would fight the very redirect meant to land them there (a loop).
  useEffect(() => {
    if (gate === 'onboarding' && !onOnboardingRoute) {
      void navigate({ to: '/onboarding', replace: true });
    }
  }, [gate, onOnboardingRoute, navigate]);

  // Dashboard chrome (sidebar) needs both the gate AND a resolved org — pickActiveOrgId (inside
  // useOrg) can lag the gate by nothing in practice, but guarding on activeOrg too means the
  // sidebar never renders with nothing to point it at.
  const showDashboard = gate === 'dashboard' && !!activeOrg;
  const showOnboarding = gate === 'onboarding' && onOnboardingRoute;
  // Onboarding's own step 1 creates the org that flips `gate` from 'onboarding' to 'dashboard' —
  // so this condition, unlike showDashboard/showOnboarding individually, must stay a SINGLE JSX
  // branch. Splitting it into two branches (one with the sidebar, one without) made React tear
  // down and remount that whole subtree the instant the org existed, which reset the wizard's
  // <Outlet /> — and every bit of local state in it, mid-step — back to step 1.
  const showContent = showDashboard || showOnboarding;

  return (
    <div className="flex h-full flex-col">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      {isDev ? <DevAuthBar /> : null}
      {showDashboard ? <MobileNav /> : null}
      <div className="flex min-h-0 flex-1">
        {showDashboard ? (
          <div className="hidden lg:flex">
            <Sidebar />
          </div>
        ) : null}
        {showContent ? (
          <main id="main-content" className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1200px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
              <Outlet />
            </div>
          </main>
        ) : gate === 'signed-out' ? (
          <ConnectGate />
        ) : gate === 'org-error' ? (
          <OrgLoadError onRetry={retryOrgs} />
        ) : (
          // 'auth-loading' | 'org-loading' | ('onboarding' mid-redirect, not there yet)
          <AuthLoading />
        )}
      </div>
    </div>
  );
}
