import { expect, Page } from "@playwright/test";
import { Onboarding } from "../../core/RimoriE2ETestEnvironment";

export async function completeOnboarding(
  page: Page,
  onboarding: Required<Onboarding>,
  e2ePluginId?: string,
): Promise<void> {
  console.log(`[E2E] Onboarding user`);
  console.log(`[E2E] E2E plugin ID: ${e2ePluginId}`);
  console.log(`[E2E] Onboarding: ${JSON.stringify(onboarding)}`);
  const url = e2ePluginId ? `/onboarding?flag-e2e-plugin-id=${e2ePluginId}` : `/onboarding`;

  await page.goto(url, { waitUntil: 'networkidle' });

  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  // Ensure we're on onboarding page
  await expect(page).toHaveURL(/\/onboarding/);

  // Step 1: Purpose/Long-term goal
  const goalInput = page.locator('textarea, input[type="text"]');
  await goalInput.waitFor({ state: 'visible' });
  await goalInput.click();
  await goalInput.fill("test goal");
  const continueButton = page.getByRole('button', { name: /continue/i });
  await expect(continueButton).toBeEnabled({ timeout: 10000 });
  await continueButton.click();

  // Step 2: Motivation type (auto-advances after selection)
  // Wait for the motivation step heading to appear
  const motivationHeading = page.getByText('What motivates you most?');
  await expect(motivationHeading).toBeVisible({ timeout: 10000 });
  const motivationOption = page.locator('label').filter({ hasText: '🏆Progress & Accomplishment' });
  await expect(motivationOption).toBeVisible({ timeout: 10000 });
  await motivationOption.click();

  // Step 3: Genre preference (auto-advances after selection)
  // Wait for the genre step heading to appear
  const genreHeading = page.getByText('What kind of stories do you like most?');
  await expect(genreHeading).toBeVisible({ timeout: 10000 });
  const genreOption = page.locator('label').filter({ hasText: 'Comedy' });
  await expect(genreOption).toBeVisible({ timeout: 10000 });
  await genreOption.click();

  // Step 4: Location
  // Wait for the location step to appear
  const countrySelect = page.getByLabel('Country');
  await expect(countrySelect).toBeVisible({ timeout: 10000 });
  await countrySelect.selectOption('SE');
  await page.getByLabel('City (optional)').selectOption('Malmö');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 5: Wait for setup completion
  await expect(page.getByRole('heading', { name: 'Almost there!' })).toBeVisible({ timeout: 10000 });
  await page.waitForURL('**/dashboard', { timeout: 120000 });
  // await page.screenshot({ path: path.join(process.cwd(), 'playwright/dashboard.png') });
  await expect(page.getByRole('heading', { name: "Today's Mission" })).toBeVisible({ timeout: 30000 });

  await expect(page.getByRole('button', { name: 'Grammar', exact: true })).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('heading', { name: 'Getting Started: Create your first study plan' })).toBeVisible({
    timeout: 60000,
  });
  await expect(page.getByText('Train your first flashcard deck', { exact: true })).toBeVisible({ timeout: 200000 });
  await expect(page.locator('iframe').contentFrame().getByRole('button', { name: 'Back to Plugins' })).toBeVisible({
    timeout: 250000,
  });
}