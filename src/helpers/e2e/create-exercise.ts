import { Page, expect } from '@playwright/test';

interface Exercise {
  title: string;
  description: string;
  pluginId: string;
  actionKey: string;
  parameters?: Record<string, unknown>;
}

/**
 * Creates an exercise via the CreateExerciseDialog in rimori-main.
 *
 * Navigates to the dashboard, opens the "Create exercise" dialog, and walks
 * through all 4 steps to create the exercise.
 *
 * @param page - Playwright page instance, should be authenticated on the dashboard
 * @param exercise - Exercise definition with plugin ID, action key, and parameters
 */
export async function createExerciseViaDialog(page: Page, exercise: Exercise): Promise<void> {
  await page.goto('/dashboard');
  await page.waitForTimeout(2000);

  // Open the Create Exercise dialog via the StudyBuddy section button
  const createButton = page.getByRole('button', { name: 'Create exercise', exact: true });
  await expect(createButton).toBeVisible({ timeout: 10000 });
  await createButton.click();

  // Wait for dialog to open
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible({ timeout: 5000 });

  // Step 1: Select the action matching pluginId + actionKey
  const actionButton = dialog.locator(
    `[data-plugin-id="${exercise.pluginId}"][data-action-key="${exercise.actionKey}"]`,
  );
  await expect(actionButton).toBeVisible({ timeout: 10000 });
  await actionButton.click();

  // Click "Next" to proceed to step 2
  await dialog.getByRole('button', { name: 'Next' }).click();

  // Step 2: Fill in exercise name and optional description
  const nameInput = dialog.locator('input#exercise-name');
  await expect(nameInput).toBeVisible({ timeout: 5000 });
  await nameInput.fill(exercise.title);

  if (exercise.description) {
    const descInput = dialog.locator('textarea#exercise-description');
    await descInput.fill(exercise.description);
  }

  // Explicitly set dates using local timezone to avoid UTC date drift in the deployed rimori-main
  // (rimori-main initialises dates with toISOString() which returns UTC, causing "Next" to be
  //  disabled when the local clock is past UTC midnight but the UTC date is still "yesterday").
  const localDateStr = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = localDateStr(new Date());
  const weekLaterStr = localDateStr(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

  const startDateInput = dialog.locator('input#start-date');
  if (await startDateInput.count() > 0) {
    await startDateInput.fill(todayStr);
  }
  const endDateInput = dialog.locator('input#end-date');
  if (await endDateInput.count() > 0) {
    await endDateInput.fill(weekLaterStr);
  }

  const nextBtn = dialog.getByRole('button', { name: 'Next' });
  await expect(nextBtn).toBeEnabled({ timeout: 5000 });
  await nextBtn.click();

  // Step 3: Fill in action parameters
  if (exercise.parameters) {
    for (const [key, value] of Object.entries(exercise.parameters)) {
      // Try combobox (Radix Select) first — rendered with role="combobox"
      const combobox = dialog.locator(`[id="param-${key}"][role="combobox"]`);
      if (await combobox.count() > 0) {
        await combobox.click();
        await page.getByRole('option', { name: new RegExp(`^${String(value)}$`, 'i') }).click();
        continue;
      }

      // Number input
      const numberInput = dialog.locator(`input#param-${key}[type="number"]`);
      if (await numberInput.count() > 0) {
        await numberInput.fill(String(value));
        continue;
      }

      // Text input (default)
      const textInput = dialog.locator(`input#param-${key}`);
      if (await textInput.count() > 0) {
        await textInput.fill(String(value));
      }
    }
  }

  await dialog.getByRole('button', { name: 'Next' }).click();

  // Step 4: Create (without sharing)
  const createExerciseButton = dialog.getByRole('button', { name: 'Create exercise' });
  await expect(createExerciseButton).toBeEnabled({ timeout: 5000 });
  await createExerciseButton.click();

  // Wait for dialog to close (exercise created successfully)
  await expect(dialog).toBeHidden({ timeout: 15000 });
}
