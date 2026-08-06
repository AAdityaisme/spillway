import { createRootRoute, createRoute, createRouter, Link } from '@tanstack/react-router';
import { AppShell } from './components/layout/AppShell.js';
import { AlertsPage } from './pages/Alerts.js';
import { ApprovalsPage } from './pages/Approvals.js';
import { BudgetsPage } from './pages/Budgets.js';
import { FeedPage } from './pages/Feed.js';
import { InsightsPage } from './pages/Insights.js';
import { KeysPage } from './pages/Keys.js';
import { OnboardingPage } from './pages/Onboarding.js';
import { OverviewPage } from './pages/Overview.js';
import { PoliciesPage } from './pages/Policies.js';
import { ProvidersPage } from './pages/Providers.js';
import { ReportsPage } from './pages/Reports.js';
import { RequestsPage } from './pages/Requests.js';
import { RoutingPage } from './pages/Routing.js';
import { SettingsPage } from './pages/Settings.js';
import { TeamPage } from './pages/Team.js';

/**
 * Code-based route tree (documented deviation from the bible's file-based routes: one
 * explicit tree, no codegen plugin — same URLs, simpler graft). Role gating is enforced
 * server-side; the sidebar hides what a role can't use.
 */

function NotFoundPage(): React.ReactElement {
  return (
    <div className="flex h-52 flex-col items-center justify-center gap-2 text-sm text-[var(--ink-mut)]">
      <div>Page not found.</div>
      <Link to="/" className="text-[var(--blue)] underline">
        Back to Overview
      </Link>
    </div>
  );
}

const rootRoute = createRootRoute({ component: AppShell, notFoundComponent: NotFoundPage });

const route = <P extends string>(path: P, component: () => React.ReactElement) =>
  createRoute({ getParentRoute: () => rootRoute, path, component });

// Deep-linkable search params (bible §3.7): /keys?drawer=<id>, /requests?drawer=<id>.
const drawerSearch = (search: Record<string, unknown>): { drawer?: string } => ({
  drawer: typeof search.drawer === 'string' ? search.drawer : undefined,
});

const overviewRoute = route('/', OverviewPage);
const feedRoute = route('/feed', FeedPage);
const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/requests',
  component: RequestsPage,
  validateSearch: drawerSearch,
});
const keysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/keys',
  component: KeysPage,
  validateSearch: drawerSearch,
});
const providersRoute = route('/providers', ProvidersPage);
const budgetsRoute = route('/budgets', BudgetsPage);
const approvalsRoute = route('/approvals', ApprovalsPage);
const policiesRoute = route('/policies', PoliciesPage);
const alertsRoute = route('/alerts', AlertsPage);
const routingRoute = route('/routing', RoutingPage);
const reportsRoute = route('/reports', ReportsPage);
const insightsRoute = route('/insights', InsightsPage);
const teamRoute = route('/team', TeamPage);
const settingsRoute = route('/settings', SettingsPage);
const onboardingRoute = route('/onboarding', OnboardingPage);

export const router = createRouter({
  // M4-auth: the SPA is mounted at /app behind the landing page. Must match vite.config.ts `base`
  // or client-side navigation writes URLs the server does not serve.
  basepath: '/app',
  routeTree: rootRoute.addChildren([
    overviewRoute,
    feedRoute,
    requestsRoute,
    keysRoute,
    providersRoute,
    budgetsRoute,
    approvalsRoute,
    policiesRoute,
    alertsRoute,
    routingRoute,
    reportsRoute,
    insightsRoute,
    teamRoute,
    settingsRoute,
    onboardingRoute,
  ]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
