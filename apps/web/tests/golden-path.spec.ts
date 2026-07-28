import { expect, test } from '@playwright/test';

/**
 * Golden path (bible §7.2, adapted to the dev-auth seam): connect → overview KPIs →
 * live feed with a blocked row → request detail with routing trace → create a virtual
 * key (copy-once reveal) → pause/unpause → revoke → budget editor prefill → chargeback
 * statement + CSV download → guardrail policy create/delete.
 *
 * Preconditions: full local stack running + demo seed applied + env:
 *   SPILLWAY_DEV_JWT / SPILLWAY_DEV_ORG (from `pnpm dev:token`), org plan = governance.
 */

const JWT = process.env.SPILLWAY_DEV_JWT ?? '';
const ORG = process.env.SPILLWAY_DEV_ORG ?? '';

test.beforeEach(async ({ page }) => {
  test.skip(!JWT || !ORG, 'SPILLWAY_DEV_JWT / SPILLWAY_DEV_ORG not set');
  await page.addInitScript(
    ([jwt, org]) => {
      localStorage.setItem('spillway_dev_token', jwt as string);
      localStorage.setItem('spillway_active_org', org as string);
    },
    [JWT, ORG],
  );
});

test('overview shows live KPIs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('overview-stat-spend')).toBeVisible();
  await expect(page.getByTestId('overview-stat-spend')).not.toHaveText('—');
  await expect(page.getByTestId('overview-stat-blocked')).toBeVisible();
});

test('feed surfaces blocked requests with reason chips', async ({ page }) => {
  await page.goto('/feed');
  await page.getByRole('button', { name: 'Blocked', exact: true }).click();
  const rows = page.locator('[data-testid^="feed-row-"]');
  await expect(rows.first()).toBeVisible();
  await expect(page.getByText('Budget exceeded', { exact: false }).first()).toBeVisible();
});

test('request drawer shows cost breakdown and routing trace', async ({ page }) => {
  await page.goto('/requests');
  const row = page.locator('[data-testid^="requests-row-"]').first();
  await row.click();
  await expect(page.getByText('Tokens & cost')).toBeVisible();
  await expect(page.getByText('Total cost')).toBeVisible();
  // Governance org + admin role → the trace section renders (may be empty for seed rows).
  await expect(page.getByText('Routing trace')).toBeVisible();
});

test('virtual key lifecycle: create → reveal once → pause → unpause → revoke', async ({ page }) => {
  const name = `e2e-key-${Date.now()}`;
  await page.goto('/keys');
  await page.getByTestId('keys-create-btn').click();
  await page.getByTestId('keys-create-name-input').fill(name);
  await page.getByTestId('keys-create-submit-btn').click();

  // Copy-once reveal: plaintext appears exactly here, never again.
  await expect(page.getByText('Copy your key now')).toBeVisible();
  await expect(page.locator('code', { hasText: 'mk-live-' })).toBeVisible();
  await page.getByTestId('key-reveal-confirm-btn').click();

  const row = page.locator('tr', { hasText: name });
  await expect(row).toBeVisible();
  await row.getByTestId('keys-row-pause-btn').click();
  await expect(row.getByText('paused')).toBeVisible();
  await row.getByTestId('keys-row-pause-btn').click(); // unpause
  await expect(row.getByText('active')).toBeVisible();

  await row.getByTestId('keys-row-revoke-btn').click();
  const prefix = await row.locator('.num').first().textContent();
  await page.locator('#revoke-confirm').fill((prefix ?? '').replace('…', ''));
  await page.getByTestId('keys-revoke-confirm-btn').click();
  await expect(row.getByText('revoked')).toBeVisible();
});

test('budget editor prefills from a budgeted node', async ({ page }) => {
  await page.goto('/budgets');
  // Any node showing "Edit" carries a budget — fixtures differ on which scopes have one.
  const budgeted = page
    .locator('[data-testid="budgets-tree-org-node"], [data-testid^="budgets-node-"]')
    .filter({ hasText: 'Edit' })
    .first();
  await budgeted.click();
  await expect(page.getByTestId('budgets-limit-input')).not.toHaveValue('');
  await expect(page.getByTestId('budgets-save-btn')).toBeEnabled();
});

test('chargeback statement renders and CSV downloads', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.getByText('Total spend', { exact: false }).first()).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('reports-download-csv-btn').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('chargeback.csv');
});

test('guardrail policy create and delete', async ({ page }) => {
  const name = `e2e-policy-${Date.now()}`;
  await page.goto('/policies');
  await page.getByTestId('policies-new-btn').click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Reason').fill('e2e temporary policy');
  await page.getByTestId('policies-drawer-submit-btn').click();
  const row = page.locator('tr', { hasText: name });
  await expect(row).toBeVisible();
  await row.locator('[data-testid^="policies-delete-btn-"]').click();
  await page.getByTestId('policies-delete-confirm-btn').click();
  await expect(row).toHaveCount(0);
});
