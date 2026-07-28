import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Drawer } from '../components/primitives/Drawer.js';
import { EmptyState } from '../components/primitives/EmptyState.js';
import { Field, Input } from '../components/primitives/Field.js';
import { Select, type SelectOption } from '../components/primitives/Select.js';
import { Table, type Column } from '../components/primitives/Table.js';
import { Tooltip } from '../components/primitives/Tooltip.js';
import { ApiError, api, type Member, type Role } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { dateLabel } from '../lib/format.js';
import { useOrg } from '../lib/org.js';

/** Badge color per role — owner is the one blue "top" role, admin reads as an ok/pass state. */
const ROLE_BADGE: Record<Role, 'blue' | 'pass' | 'neutral'> = {
  owner: 'blue',
  admin: 'pass',
  member: 'neutral',
  viewer: 'neutral',
};

const ROLE_OPTIONS_OWNER: SelectOption[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];
const ROLE_OPTIONS_ADMIN: SelectOption[] = [
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];

/** Admins can't touch owner/admin rows (nor grant those roles) — only an owner can (api-inventory §3). */
function canEditRole(viewerRole: Role | null, targetRole: Role): boolean {
  if (viewerRole === 'owner') return true;
  if (viewerRole === 'admin') return targetRole === 'member' || targetRole === 'viewer';
  return false;
}

/** Invite drawer body: WorkOS user id + role, gated to what the inviter's own role may grant. */
function InviteDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { activeOrgId } = useAuth();
  const { role } = useOrg();
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('member');
  const [fieldError, setFieldError] = useState<string | null>(null);

  const reset = (): void => {
    setUserId('');
    setInviteRole('member');
    setFieldError(null);
  };

  const invite = useMutation({
    mutationFn: () => api.inviteMember({ userId: userId.trim(), role: inviteRole }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'members'] });
      toast.success('Added to org');
      reset();
      onClose();
    },
    onError: (err) => {
      // The global taxonomy already toasts this — inline surfacing is additive, not a replacement.
      if (err instanceof ApiError && err.code === 'validation_error') setFieldError(err.message);
    },
  });

  const roleOptions = role === 'owner' ? ROLE_OPTIONS_OWNER : ROLE_OPTIONS_ADMIN;

  return (
    <Drawer
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Invite member"
      width="sm"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={() => invite.mutate()}
            loading={invite.isPending}
            disabled={!userId.trim()}
            data-testid="team-invite-submit-btn"
          >
            Invite
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label="WorkOS user ID"
          htmlFor="invite-user-id"
          hint="The user must have signed in to Spillway at least once — ask them to log in first, then paste their user ID (user_…)."
          error={fieldError}
        >
          <Input
            id="invite-user-id"
            data-testid="team-invite-userid-input"
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              setFieldError(null);
            }}
            placeholder="user_01H..."
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Role" htmlFor="invite-role">
          <Select
            id="invite-role"
            testId="team-invite-role-select"
            value={inviteRole}
            onValueChange={(v) => setInviteRole(v as Role)}
            options={roleOptions}
          />
        </Field>
      </div>
    </Drawer>
  );
}

/** Team (bible §3.16), adapted: invites are by WorkOS user id, not email (api-inventory §3). Admin+ page. */
export function TeamPage() {
  const { session, activeOrgId } = useAuth();
  const { role } = useOrg();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);

  const q = useQuery({
    queryKey: [activeOrgId, 'members'],
    queryFn: api.listMembers,
    enabled: !!session && !!activeOrgId,
  });

  const updateRole = useMutation({
    mutationFn: ({ userId, role: newRole }: { userId: string; role: Role }) =>
      api.updateMemberRole(userId, newRole),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'members'] });
      toast.success('Role updated');
    },
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.removeMember(userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'members'] });
      toast.success('Member removed');
      setRemoveTarget(null);
    },
  });

  const members = q.data?.members ?? [];

  const columns: Column<Member>[] = [
    {
      key: 'member',
      header: 'Member',
      render: (m) => {
        const primary = m.name ?? m.email ?? m.userId;
        return (
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--blue-soft)] text-[12px] font-semibold text-[var(--blue)]"
            >
              {primary.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-[var(--ink)]">{primary}</div>
              {m.name && m.email ? (
                <div className="truncate text-xs text-[var(--ink-mut)]">{m.email}</div>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      key: 'role',
      header: 'Role',
      render: (m) =>
        canEditRole(role, m.role) ? (
          <Select
            value={m.role}
            onValueChange={(v) => updateRole.mutate({ userId: m.userId, role: v as Role })}
            options={role === 'owner' ? ROLE_OPTIONS_OWNER : ROLE_OPTIONS_ADMIN}
            testId={`team-role-select-${m.userId}`}
          />
        ) : (
          <Tooltip content="Only owners can change admin roles">
            <span className="inline-flex">
              <Badge variant={ROLE_BADGE[m.role]}>{m.role}</Badge>
            </span>
          </Tooltip>
        ),
    },
    {
      key: 'joined',
      header: 'Joined',
      render: (m) => (
        <span className="num text-xs text-[var(--ink-mut)]">{dateLabel(m.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (m) => (
        <Button
          variant="danger-ghost"
          size="sm"
          icon={<Trash2 size={13} aria-hidden />}
          onClick={() => setRemoveTarget(m)}
          data-testid={`team-remove-btn-${m.userId}`}
        >
          Remove
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Team"
        sub="Everyone with access to this org, and what they can do."
        actions={
          <Button
            icon={<UserPlus size={14} aria-hidden />}
            onClick={() => setInviteOpen(true)}
            data-testid="team-invite-btn"
          >
            Invite member
          </Button>
        }
      />

      {q.error ? (
        <SectionError error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <Table
          columns={columns}
          data={members}
          rowKey={(m) => m.userId}
          loading={q.isLoading}
          testId="team-table"
          empty={
            <EmptyState
              icon={<Users size={20} />}
              headline="No members found."
              body="Something may have gone wrong loading your team. Refresh to try again."
              action={{
                label: 'Refresh',
                onClick: () => void q.refetch(),
                testId: 'team-empty-refresh-btn',
              }}
            />
          }
        />
      )}

      <InviteDrawer open={inviteOpen} onClose={() => setInviteOpen(false)} />

      <Dialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        destructive
        title="Remove this member?"
        description="They immediately lose access to this org."
        actions={
          <>
            <Button variant="ghost" onClick={() => setRemoveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={removeMember.isPending}
              onClick={() => removeTarget && removeMember.mutate(removeTarget.userId)}
              data-testid="team-remove-confirm-btn"
            >
              Remove
            </Button>
          </>
        }
      />
    </div>
  );
}
