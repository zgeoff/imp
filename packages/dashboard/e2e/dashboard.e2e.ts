// oxlint-disable zgeoff/no-destructured-params -- Playwright reads fixture names from the pattern
import { expect, test } from '@playwright/test';

test.skip(
  process.env['IMP_TOKEN'] === undefined,
  'IMP_TOKEN names the token of the impd under test',
);

test('it logs in, creates an imp, runs a command in its console and destroys it', async ({
  page,
}) => {
  const token = process.env['IMP_TOKEN'] ?? '';

  // the harness's suite (test/e2e/suites/dashboard.e2e.ts) names the prefix,
  // so its cleanup finds the imp, and a small fixture image; '' picks the
  // default image
  const prefix = process.env['E2E_IMP_PREFIX'] ?? 'e2e-dash-';
  const image = process.env['E2E_IMP_IMAGE'] ?? '';
  const name = `${prefix}${String(Date.now() % 100_000)}`;

  await page.goto('/');

  await expect(page).toHaveURL(/\/ui\/login$/);

  await page.getByLabel('API token').fill(token);
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page.getByRole('heading', { name: 'Imps' })).toBeVisible();
  await expect(page.getByRole('meter', { name: 'RAM in use' })).toBeVisible();

  // the browser holds the session cookie and never the token
  const cookies = await page.context().cookies();

  const session = cookies.find((cookie) => cookie.name === 'imp_session');

  if (session === undefined) {
    throw new Error('the login set no imp_session cookie');
  }

  expect(session.httpOnly).toBe(true);
  expect(session.value).not.toContain(token);

  await page.getByRole('button', { name: 'New imp' }).click();

  const dialog = page.getByRole('dialog', { name: 'New imp' });

  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Memory (MiB)').fill('512');
  await dialog.getByLabel('Image').selectOption(image);
  await dialog.getByRole('button', { name: 'Create' }).click();

  const row = page.getByRole('row', { name: new RegExp(name) });

  await expect(row.getByText('running')).toBeVisible();

  await row.getByRole('link', { name: 'Console' }).click();

  await expect(page.getByRole('status')).toHaveText('connected');

  // the shell's arithmetic, not the echoed command line, proves it ran
  const marker = `dashboard-${String(Date.now())}`;

  await page.getByTestId('console-screen').click();
  await page.keyboard.type(`echo $((40 + 2))-${marker}\n`);

  await expect(page.getByTestId('console-screen')).toContainText(`42-${marker}`);

  await page.keyboard.type('exit\n');

  await expect(page.getByRole('status')).toHaveText('exited with code 0');

  await page.getByRole('link', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Sleep' }).click();

  await expect(page.getByText('sleeping', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Destroy' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Destroy' }).click();

  await expect(page.getByRole('heading', { name: 'Imps' })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);

  await page.getByRole('button', { name: 'Log out' }).click();

  await expect(page).toHaveURL(/\/ui\/login$/);

  // the session is gone: the list sends the browser back to the login
  await page.goto('/ui/');

  await expect(page).toHaveURL(/\/ui\/login$/);
});
