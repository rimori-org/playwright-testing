import { expect, Page } from "@playwright/test";

export interface Onboarding {
  learning_reason?: keyof typeof learningReasonMap;
  target_country?: string;
  target_city?: string;
  interests?: string;
}

const learningReasonMap = {
  work: 'For my job',
  relationship: 'For my relationship',
  friends_family: 'For friends and family',
  education: 'For education',
  moving: 'Moving or living abroad',
  culture_travel: 'For culture and travel',
  self_improvement: 'Self-improvement',
  citizenship: 'For citizenship or residency',
  other: 'Other reason',
  speaking: 'What is your main motivation to learn Swedish?',
};

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

  // Step 1: Learning Reason (radio select, auto-advances after selection)
  const learningReasonOption = page.getByText(learningReasonMap[onboarding.learning_reason]);
  await expect(learningReasonOption).toBeVisible({ timeout: 10000 });
  await learningReasonOption.click();

  // Step 2: Interests (textarea with continue button)
  await page.waitForTimeout(1000);
  const interestsTextarea = page.locator('textarea');
  await expect(interestsTextarea).toBeVisible({ timeout: 10000 });
  await interestsTextarea.click();
  await interestsTextarea.fill(onboarding.interests);
  const interestsContinue = page.getByRole('button', { name: /continue/i });
  await expect(interestsContinue).toBeEnabled({ timeout: 10000 });
  await interestsContinue.click();

  // Step 3: Location
  const countrySelect = page.getByLabel('Country');
  await expect(countrySelect).toBeVisible({ timeout: 10000 });
  await countrySelect.selectOption(onboarding.target_country);
  await page.getByLabel('City (optional)').selectOption(onboarding.target_city);
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 4: Study Buddy (card select, auto-advances after selection)
  // Wait for study buddy step and click the first buddy card
  await page.waitForTimeout(1000);
  const buddyCard = page
    .locator('button')
    .filter({ has: page.locator('img') })
    .first();
  await expect(buddyCard).toBeVisible({ timeout: 10000 });
  await buddyCard.click();

  // Step 5: Wait for setup completion
  await expect(page.getByRole('heading', { name: 'Almost there!' })).toBeVisible({ timeout: 10000 });
  await page.waitForURL('**/dashboard', { timeout: 120000 });
  await expect(page.getByRole('heading', { name: "Today's Mission" })).toBeVisible({ timeout: 30000 });

  await expect(page.getByRole('button', { name: 'Grammar', exact: true })).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole('heading', { name: 'Getting Started: Create your first study plan' })).toBeVisible({
    timeout: 60000,
  });
  await expect(page.getByText('Train your first flashcard deck', { exact: true })).toBeVisible({ timeout: 200000 });
  await expect(page.locator('iframe').contentFrame().getByText('Getting Started', { exact: true })).toBeVisible({
    timeout: 250000,
  });
}
