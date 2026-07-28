import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SectionError } from '../components/domain/SectionError.js';
import { PageHeader } from '../components/layout/PageHeader.js';
import { Badge } from '../components/primitives/Badge.js';
import { Button } from '../components/primitives/Button.js';
import { Callout } from '../components/primitives/Callout.js';
import { Card } from '../components/primitives/Card.js';
import { Dialog } from '../components/primitives/Dialog.js';
import { Field, Input } from '../components/primitives/Field.js';
import { Skeleton } from '../components/primitives/Skeleton.js';
import { Switch } from '../components/primitives/Switch.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useOrg } from '../lib/org.js';

/**
 * Settings (bible §3.17), owner-only. Sidebar already hides this route for non-owners; the
 * in-page check below covers direct navigation. Three concerns: org identity, the data-retention
 * policy that gates whether prompt/response bodies are ever persisted (ADR-013), and a billing
 * placeholder (ADR-017/018 — no paid plans yet, so no self-serve upgrade flow to build).
 */
export function SettingsPage() {
  const { session, activeOrgId } = useAuth();
  const { role } = useOrg();
  const queryClient = useQueryClient();
  const isOwner = role === 'owner';

  const q = useQuery({
    queryKey: [activeOrgId, 'org'],
    queryFn: api.getOrg,
    enabled: !!session && !!activeOrgId && isOwner,
  });
  const org = q.data?.org;

  const [name, setName] = useState('');
  const [bodyRetentionDays, setBodyRetentionDays] = useState('');
  const [metadataRetentionDays, setMetadataRetentionDays] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Sync local fields from the fetched org exactly once — later background refetches (e.g. after
  // a save) must not clobber whatever the user is mid-typing in the other field group.
  const synced = useRef(false);

  useEffect(() => {
    if (!org || synced.current) return;
    synced.current = true;
    setName(org.name);
    setBodyRetentionDays(String(org.bodyRetentionDays));
    setMetadataRetentionDays(String(org.metadataRetentionDays));
  }, [org]);

  /** OrgProvider caches name/plan via the ['orgs'] bootstrap list — invalidate both so the sidebar updates too. */
  const invalidateOrg = (): void => {
    void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'org'] });
    void queryClient.invalidateQueries({ queryKey: ['orgs'] });
  };

  const saveName = useMutation({
    mutationFn: (body: { name: string }) => api.updateOrg(body),
    onSuccess: () => {
      toast.success('Saved');
      invalidateOrg();
    },
  });

  const saveRetention = useMutation({
    mutationFn: (body: { bodyRetentionDays: number; metadataRetentionDays: number }) =>
      api.updateOrg(body),
    onSuccess: () => {
      toast.success('Saved');
      invalidateOrg();
    },
  });

  const toggleBodyLogging = useMutation({
    mutationFn: (body: { bodyLoggingEnabled: boolean }) => api.updateOrg(body),
    onSuccess: (_data, variables) => {
      toast.success(
        variables.bodyLoggingEnabled ? 'Body logging enabled' : 'Body logging disabled',
      );
      invalidateOrg();
      setConfirmOpen(false);
    },
  });

  if (!isOwner) {
    return (
      <div>
        <PageHeader title="Settings" sub="Org identity, data policy, and billing." />
        <Card>Owner access required.</Card>
      </div>
    );
  }

  const nameDirty = !!org && name !== org.name;
  const bodyDays = Number(bodyRetentionDays);
  const metaDays = Number(metadataRetentionDays);
  const retentionValid =
    Number.isInteger(bodyDays) &&
    bodyDays >= 1 &&
    bodyDays <= 365 &&
    Number.isInteger(metaDays) &&
    metaDays >= 1 &&
    metaDays <= 365;
  const retentionDirty =
    !!org &&
    (bodyRetentionDays !== String(org.bodyRetentionDays) ||
      metadataRetentionDays !== String(org.metadataRetentionDays));

  return (
    <div className="max-w-2xl">
      <PageHeader title="Settings" sub="Org identity, data policy, and billing." />

      {q.isLoading ? (
        <div className="flex flex-col gap-4">
          <Card>
            <Skeleton className="h-32 w-full" />
          </Card>
          <Card>
            <Skeleton className="h-40 w-full" />
          </Card>
        </div>
      ) : q.error ? (
        <SectionError error={q.error} onRetry={() => void q.refetch()} />
      ) : org ? (
        <div className="flex flex-col gap-4">
          <Card>
            <div className="eyebrow mb-4">General</div>
            <div className="flex flex-col gap-4">
              <Field label="Org name" htmlFor="org-name">
                <Input
                  id="org-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="settings-org-name-input"
                />
              </Field>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={!nameDirty || !name.trim() || saveName.isPending}
                  loading={saveName.isPending}
                  onClick={() => saveName.mutate({ name: name.trim() })}
                  data-testid="settings-org-name-save-btn"
                >
                  Save
                </Button>
              </div>
              <Field
                label="Slug"
                htmlFor="org-slug"
                hint="Slugs are permanent — changing them would break integrations."
              >
                <Input id="org-slug" value={org.slug} readOnly className="font-mono text-xs" />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">Plan</span>
                <Badge variant="blue">{org.plan}</Badge>
              </div>
            </div>
          </Card>

          <Card>
            <div className="eyebrow mb-4">Data policy</div>
            <Callout title="Privacy">
              Enabling body logging stores the full text of every prompt and response in your
              database. This may include sensitive information. Bodies are retained for the
              configured number of days, then permanently deleted. Only enable this if your use case
              requires it and your team has reviewed the privacy implications.
            </Callout>

            <div className="mt-4 flex items-center justify-between">
              <label htmlFor="body-logging" className="text-[13px] font-medium">
                Body logging
              </label>
              <Switch
                id="body-logging"
                checked={org.bodyLoggingEnabled}
                onCheckedChange={(checked) => {
                  if (checked) setConfirmOpen(true);
                  else toggleBodyLogging.mutate({ bodyLoggingEnabled: false });
                }}
                disabled={toggleBodyLogging.isPending}
                testId="settings-body-logging-toggle"
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4">
              {org.bodyLoggingEnabled ? (
                <Field label="Body retention (days)" htmlFor="body-retention-days">
                  <Input
                    id="body-retention-days"
                    type="number"
                    min={1}
                    max={365}
                    value={bodyRetentionDays}
                    onChange={(e) => setBodyRetentionDays(e.target.value)}
                    data-testid="settings-body-retention-input"
                  />
                </Field>
              ) : null}
              <Field label="Metadata retention (days)" htmlFor="metadata-retention-days">
                <Input
                  id="metadata-retention-days"
                  type="number"
                  min={1}
                  max={365}
                  value={metadataRetentionDays}
                  onChange={(e) => setMetadataRetentionDays(e.target.value)}
                  data-testid="settings-metadata-retention-input"
                />
              </Field>
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                size="sm"
                disabled={!retentionDirty || !retentionValid || saveRetention.isPending}
                loading={saveRetention.isPending}
                onClick={() =>
                  saveRetention.mutate({
                    bodyRetentionDays: bodyDays,
                    metadataRetentionDays: metaDays,
                  })
                }
                data-testid="settings-retention-save-btn"
              >
                Save
              </Button>
            </div>
          </Card>

          <Card className="bg-[var(--paper-warm)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[15px] font-semibold tracking-[-0.01em]">
                  Billing &amp; Plan
                </div>
                <p className="mt-1.5 max-w-md text-sm text-[var(--ink-mut)]">
                  Billing lands with the first paid subscription. Until then, plans are set by the
                  Spillway team — contact us to upgrade.
                </p>
              </div>
              <Badge variant="blue">{org.plan}</Badge>
            </div>
            <div className="mt-4">
              <a
                href="/#pricing"
                data-testid="settings-billing-view-plans-link"
                className="focus-ring inline-flex h-8 items-center justify-center rounded-[var(--radius-btn)] bg-[var(--card)] px-3 text-[13px] font-semibold text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--line)] transition-shadow hover:shadow-[inset_0_0_0_1px_rgba(0,102,204,0.45)]"
              >
                View plans
              </a>
            </div>
          </Card>
        </div>
      ) : null}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        destructive
        title="Enable body logging?"
        description={`This will store all prompt and response bodies for up to ${bodyRetentionDays} days. Confirm your team has reviewed the data policy.`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={toggleBodyLogging.isPending}
              onClick={() => toggleBodyLogging.mutate({ bodyLoggingEnabled: true })}
              data-testid="settings-body-logging-confirm-btn"
            >
              Enable body logging
            </Button>
          </>
        }
      />
    </div>
  );
}
