import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Fragment, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/primitives/Button.js';
import { Card } from '../components/primitives/Card.js';
import { CodeBlock } from '../components/primitives/CodeBlock.js';
import { Field, Input } from '../components/primitives/Field.js';
import { KeyRevealDialog } from '../components/primitives/KeyRevealDialog.js';
import { Select } from '../components/primitives/Select.js';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';

type Step = 1 | 2 | 3 | 4;

const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: 'Organization' },
  { n: 2, label: 'Provider' },
  { n: 3, label: 'Virtual key' },
  { n: 4, label: 'Quickstart' },
];

const SLUG_RE = /^[a-z0-9-]+$/;

/** Derives a URL-safe slug from an org name; a manual edit to the slug field wins from then on. */
function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** Stepper pill row: done = solid blue, current = blue ring, future = muted hairline. */
function Stepper({ step }: { step: Step }) {
  return (
    <div className="mx-auto mb-8 flex max-w-sm items-center" data-testid="onboarding-stepper">
      {STEPS.map((s, i) => (
        <Fragment key={s.n}>
          <div
            data-testid={`onboarding-step-pill-${s.n}`}
            aria-current={s.n === step ? 'step' : undefined}
            className={`flex size-8 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-semibold ${
              s.n < step
                ? 'bg-[var(--blue)] text-white'
                : s.n === step
                  ? 'text-[var(--blue)] shadow-[inset_0_0_0_1.5px_var(--blue)]'
                  : 'text-[var(--ink-mut)] shadow-[inset_0_0_0_1px_var(--line)]'
            }`}
          >
            {String(s.n).padStart(2, '0')}
          </div>
          {i < STEPS.length - 1 ? (
            <div
              className={`h-px flex-1 ${s.n < step ? 'bg-[var(--blue)]' : 'bg-[var(--line)]'}`}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * First-run 4-step flow (bible §3.3), adapted to the real API surface: single provider
 * (openai only) and no team assignment on the first virtual key. Steps only move forward —
 * each one's mutation has already taken effect server-side, so there's nothing to "undo" by
 * going back.
 */
export function OnboardingPage() {
  const { activeOrgId, setActiveOrg } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>(1);

  // Step 1 — org
  const [orgName, setOrgName] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const slugValid = orgSlug === '' || SLUG_RE.test(orgSlug);

  // Step 2 — provider key
  const [keyLabel, setKeyLabel] = useState('');
  const [apiKey, setApiKey] = useState('');

  // Step 3 — virtual key
  const [vkeyName, setVkeyName] = useState('');
  const [revealedKey, setRevealedKey] = useState<string | null>(null);

  const createOrg = useMutation({
    mutationFn: () => api.createOrg({ name: orgName.trim(), slug: orgSlug }),
    onSuccess: (res) => {
      setActiveOrg(res.org.id);
      void queryClient.invalidateQueries({ queryKey: ['orgs'] });
      toast.success('Organization created.');
      setStep(2);
    },
  });

  const createProviderKey = useMutation({
    mutationFn: () => api.createProviderKey({ provider: 'openai', label: keyLabel.trim(), apiKey }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'provider-keys'] });
      toast.success('Provider key saved.');
      setStep(3);
    },
  });

  const createVirtualKey = useMutation({
    mutationFn: () => api.createVirtualKey({ name: vkeyName.trim() }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: [activeOrgId, 'virtual-keys'] });
      toast.success('Virtual key created.');
      setRevealedKey(res.virtualKey.key);
    },
  });

  const canCreateOrg =
    orgName.trim().length > 0 && orgSlug.length > 0 && slugValid && !createOrg.isPending;
  const canSaveKey =
    keyLabel.trim().length > 0 && apiKey.length > 0 && !createProviderKey.isPending;
  const canCreateVkey = vkeyName.trim().length > 0 && !createVirtualKey.isPending;

  const quickstart = `export OPENAI_BASE_URL=${window.location.origin}/v1\nexport OPENAI_API_KEY=<your-key>`;

  return (
    <div>
      {/* Onboarding is a brand moment (like the connect gate) — serif voice, not the console header. */}
      <div className="mb-6 text-center">
        <div className="eyebrow">welcome</div>
        <h1 className="brand-serif mt-1 text-[30px] leading-tight">
          Set up <em>Spillway</em>.
        </h1>
        <p className="mt-1 text-sm text-[var(--ink-mut)]">
          Four steps to your first governed request.
        </p>
      </div>

      <div className="mx-auto max-w-xl">
        <Stepper step={step} />

        {step === 1 ? (
          <Card padding="lg">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
              Create your organization
            </h2>
            <p className="mt-1 text-sm text-[var(--ink-mut)]">
              Everything in Spillway — keys, budgets, requests — is scoped to an org.
            </p>
            <form
              className="mt-5 flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canCreateOrg) createOrg.mutate();
              }}
            >
              <Field label="Organization name" htmlFor="onboarding-org-name">
                <Input
                  id="onboarding-org-name"
                  data-testid="onboarding-org-name-input"
                  value={orgName}
                  onChange={(e) => {
                    setOrgName(e.target.value);
                    if (!slugEdited) setOrgSlug(deriveSlug(e.target.value));
                  }}
                  placeholder="Acme Inc."
                  required
                />
              </Field>
              <Field
                label="Slug"
                htmlFor="onboarding-org-slug"
                hint={slugValid ? 'Used in URLs and API references.' : undefined}
                error={!slugValid ? 'Lowercase letters, numbers, and hyphens only.' : null}
              >
                <Input
                  id="onboarding-org-slug"
                  data-testid="onboarding-org-slug-input"
                  value={orgSlug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setOrgSlug(e.target.value);
                  }}
                  placeholder="acme-inc"
                  required
                />
              </Field>
              <Button
                type="submit"
                data-testid="onboarding-org-submit-btn"
                loading={createOrg.isPending}
                disabled={!canCreateOrg}
                className="mt-1 self-start"
              >
                Create org
              </Button>
            </form>
          </Card>
        ) : null}

        {step === 2 ? (
          <Card padding="lg">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Add a provider key</h2>
            <p className="mt-1 text-sm text-[var(--ink-mut)]">
              Spillway holds your provider credentials so your app never has to.
            </p>
            <form
              className="mt-5 flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSaveKey) createProviderKey.mutate();
              }}
            >
              <Field label="Provider" htmlFor="onboarding-provider">
                <Select
                  id="onboarding-provider"
                  testId="onboarding-provider-select"
                  value="openai"
                  onValueChange={() => {}}
                  options={[{ value: 'openai', label: 'OpenAI' }]}
                />
              </Field>
              <Field label="Label" htmlFor="onboarding-key-label">
                <Input
                  id="onboarding-key-label"
                  data-testid="onboarding-key-label-input"
                  value={keyLabel}
                  onChange={(e) => setKeyLabel(e.target.value)}
                  placeholder="Production"
                  required
                />
              </Field>
              <Field
                label="API key"
                htmlFor="onboarding-api-key"
                hint="Encrypted before storage and never returned. Only the first 8 characters are kept for display."
              >
                <Input
                  id="onboarding-api-key"
                  data-testid="onboarding-api-key-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-…"
                  required
                />
              </Field>
              <div className="mt-1 flex items-center gap-4">
                <Button
                  type="submit"
                  data-testid="onboarding-key-submit-btn"
                  loading={createProviderKey.isPending}
                  disabled={!canSaveKey}
                >
                  Save key
                </Button>
                <button
                  type="button"
                  data-testid="onboarding-skip-key-link"
                  onClick={() => setStep(3)}
                  className="focus-ring rounded-[var(--radius-btn)] font-mono text-xs text-[var(--ink-mut)] transition-colors hover:text-[var(--blue)]"
                >
                  Skip for now →
                </button>
              </div>
            </form>
          </Card>
        ) : null}

        {step === 3 ? (
          <Card padding="lg">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
              Create your first virtual key
            </h2>
            <p className="mt-1 text-sm text-[var(--ink-mut)]">
              Virtual keys are what your app authenticates with — never your raw provider key.
            </p>
            <form
              className="mt-5 flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canCreateVkey) createVirtualKey.mutate();
              }}
            >
              <Field label="Key name" htmlFor="onboarding-vkey-name">
                <Input
                  id="onboarding-vkey-name"
                  data-testid="onboarding-vkey-name-input"
                  value={vkeyName}
                  onChange={(e) => setVkeyName(e.target.value)}
                  placeholder="Default key"
                  required
                />
              </Field>
              <Button
                type="submit"
                data-testid="onboarding-vkey-submit-btn"
                loading={createVirtualKey.isPending}
                disabled={!canCreateVkey}
                className="mt-1 self-start"
              >
                Create key
              </Button>
            </form>
          </Card>
        ) : null}

        {step === 4 ? (
          <Card padding="lg">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
              Point your SDK at Spillway
            </h2>
            <p className="mt-1 text-sm text-[var(--ink-mut)]">
              Point your existing OpenAI SDK at Spillway. No other changes — streaming, tool calls,
              and all models work exactly as before.
            </p>
            <div className="mt-5">
              <CodeBlock code={quickstart} testId="onboarding-quickstart-copy-btn" />
            </div>
            <Button
              onClick={() => navigate({ to: '/' })}
              data-testid="onboarding-quickstart-btn"
              className="mt-5"
            >
              Open dashboard
            </Button>
          </Card>
        ) : null}
      </div>

      <KeyRevealDialog
        openWithKey={revealedKey}
        onDone={() => {
          setRevealedKey(null);
          setStep(4);
        }}
      />
    </div>
  );
}
