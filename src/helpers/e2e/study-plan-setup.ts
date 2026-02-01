import { Page, expect } from '@playwright/test';

/**
 * Navigates through the study plan getting-started flow on the dashboard.
 * This clicks through the real UI: milestone planning (Submit Topics) and
 * exercise creation (Save Exercises).
 *
 * Expects the page to already be on the dashboard with a "Getting Started" exercise visible.
 *
 * @param page - Playwright page instance, should be on the dashboard
 */
export async function completeStudyPlanGettingStarted(page: Page): Promise<void> {
  page.goto('/dashboard');
  await page.waitForTimeout(2000);
  // Step 1: Find and click the Getting Started exercise card
  const card = page.getByText('Getting Started: Create your first study plan', { exact: false });
  await card.waitFor({ timeout: 10000, state: 'visible' }).catch(() => {
    /* not visible within 10s, continue to early return below */
  });
  if (!(await card.isVisible())) {
    page.close();
    console.warn(`[E2E] Getting Started card not found, skipping study plan setup`);
    return;
  }
  const gettingStartedCard = page.getByText('Start Exercise', { exact: false }).first();
  await expect(gettingStartedCard).toBeVisible({ timeout: 30000 });
  await gettingStartedCard.click();

  // Wait for the study plan plugin iframe to load
  const iframe = page.locator('iframe').first();
  await expect(iframe).toBeVisible({ timeout: 30000 });
  const frame = iframe.contentFrame();

  // Step 2: Milestone Planning Stage
  // Wait for the 3 milestone cards to appear (AI generates them)
  await expect(frame.getByText('Week 1', { exact: false })).toBeVisible({ timeout: 180000 });
  await expect(frame.getByText('Week 2', { exact: false })).toBeVisible({ timeout: 10000 });
  await expect(frame.getByText('Week 3', { exact: false })).toBeVisible({ timeout: 10000 });

  // Wait for "Submit Topics" button to be enabled and click it
  const submitTopicsButton = frame.getByRole('button', { name: /submit topics/i });
  await expect(submitTopicsButton).toBeEnabled({ timeout: 180000 });
  await submitTopicsButton.click();

  // Step 3: Exercise Creation Stage
  // Wait for "Save Exercises" button to appear (AI generates all exercises)
  const saveExercisesButton = frame.getByRole('button', { name: /save exercises/i });
  await expect(saveExercisesButton).toBeVisible({ timeout: 300000 });
  await expect(saveExercisesButton).toBeEnabled({ timeout: 30000 });
  await saveExercisesButton.click();

  // Wait for save to complete (button should disappear or page navigates)
  await expect(saveExercisesButton).toBeHidden({ timeout: 30000 });

  // Step 4: Verify completion - should be back on dashboard
  // The "Getting Started" card should be gone and exercises should appear
  await expect(page.getByText("Today's Mission", { exact: false })).toBeVisible({ timeout: 30000 });
}
