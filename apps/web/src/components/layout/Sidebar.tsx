import { Link } from '@tanstack/react-router';
import {
  Activity,
  ArrowLeftRight,
  BadgeCheck,
  Bell,
  FileText,
  KeyRound,
  LayoutDashboard,
  Lightbulb,
  ListTree,
  Plug,
  Settings,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Role } from '../../lib/api.js';
import { roleAtLeast, useOrg } from '../../lib/org.js';
import { OrgSwitcher } from './OrgSwitcher.js';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** Minimum role — items the server would 403 are hidden, not teased (server enforces regardless). */
  minRole?: Role;
}

const GROUPS: Array<{ label: string | null; items: NavItem[] }> = [
  {
    label: null,
    items: [
      { to: '/', label: 'Overview', icon: <LayoutDashboard size={15} aria-hidden /> },
      { to: '/feed', label: 'Live feed', icon: <Activity size={15} aria-hidden /> },
      { to: '/requests', label: 'Requests', icon: <ListTree size={15} aria-hidden /> },
    ],
  },
  {
    label: 'Govern',
    items: [
      {
        to: '/budgets',
        label: 'Budgets',
        icon: <Wallet size={15} aria-hidden />,
        minRole: 'admin',
      },
      { to: '/approvals', label: 'Approvals', icon: <BadgeCheck size={15} aria-hidden /> },
      {
        to: '/policies',
        label: 'Policies',
        icon: <ShieldCheck size={15} aria-hidden />,
        minRole: 'admin',
      },
      { to: '/alerts', label: 'Alerts', icon: <Bell size={15} aria-hidden />, minRole: 'admin' },
    ],
  },
  {
    label: 'Route',
    items: [
      { to: '/keys', label: 'Virtual keys', icon: <KeyRound size={15} aria-hidden /> },
      {
        to: '/providers',
        label: 'Providers',
        icon: <Plug size={15} aria-hidden />,
        minRole: 'admin',
      },
      {
        to: '/routing',
        label: 'Routing',
        icon: <ArrowLeftRight size={15} aria-hidden />,
        minRole: 'admin',
      },
    ],
  },
  {
    label: 'Finance',
    items: [
      {
        to: '/reports',
        label: 'Reports',
        icon: <FileText size={15} aria-hidden />,
        minRole: 'admin',
      },
      { to: '/insights', label: 'Insights', icon: <Lightbulb size={15} aria-hidden /> },
    ],
  },
  {
    label: 'Org',
    items: [
      { to: '/team', label: 'Team', icon: <Users size={15} aria-hidden />, minRole: 'admin' },
      {
        to: '/settings',
        label: 'Settings',
        icon: <Settings size={15} aria-hidden />,
        minRole: 'owner',
      },
    ],
  },
];

/** App navigation — paper-warm rail, mono wordmark, role-filtered groups. */
export function Sidebar() {
  const { role } = useOrg();

  const linkBase =
    'focus-ring flex items-center gap-2.5 rounded-[var(--radius-btn)] px-2.5 py-[7px] text-[13px] font-medium text-[var(--ink-read)] transition-colors duration-100 hover:bg-[var(--card)] hover:text-[var(--ink)]';
  const linkActive = 'bg-[var(--card)] text-[var(--blue)] shadow-[inset_0_0_0_1px_var(--line)]';

  return (
    <nav
      aria-label="Primary"
      className="flex w-[220px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-[var(--line)] bg-[var(--paper-warm)] px-3 py-4"
    >
      <div className="flex items-center gap-2 px-2 pb-2 font-mono text-[13px] font-semibold tracking-[0.18em] text-[var(--ink)]">
        <span aria-hidden className="size-2 rounded-full bg-[var(--blue)]" />
        SPILLWAY
      </div>
      <OrgSwitcher />
      <div className="mt-2 flex flex-col gap-4">
        {GROUPS.map((g) => {
          const items = g.items.filter((i) => !i.minRole || roleAtLeast(role, i.minRole));
          if (items.length === 0) return null;
          return (
            <div key={g.label ?? 'main'} className="flex flex-col gap-0.5">
              {g.label ? <div className="eyebrow px-2.5 pb-1.5">{g.label}</div> : null}
              {items.map((i) => (
                <Link
                  key={i.to}
                  to={i.to}
                  className={linkBase}
                  activeOptions={{ exact: i.to === '/' }}
                  activeProps={{ className: `${linkBase} ${linkActive}` }}
                >
                  {i.icon}
                  {i.label}
                </Link>
              ))}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
