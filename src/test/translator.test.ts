import { test, expect } from '@playwright/test';
import { RimoriTestEnvironment } from '../core/RimoriTestEnvironment';

const pluginId = 'pl7720512027';
const pluginUrl = 'http://localhost:3009';

test.describe('Translator Plugin', () => {
  let env: RimoriTestEnvironment;

  test.beforeEach(async ({ page }) => {
    env = new RimoriTestEnvironment({ page, pluginId, pluginUrl });

    env.ai.mockGetObject(
      {
        gramatically_corrected_input_text: 'tree',
        detected_language: 'English',
        text_type: 'noun',
        word_unexisting_likelihood: 0,
        translation_mother_tongue: 'tree',
        translation_swedish: 'träd',
        translation_noun_singular: 'tree',
        plural: 'träd',
        en_ett_word: 'ett',
        alternative_meaning_mother_tongue: '',
      },
      {
        matcher: (request) => {
          const body = request.postDataJSON() as { instructions?: string };
          return body?.instructions?.includes('Look up the word or phrase') ?? false;
        },
      },
    );

    env.ai.mockGetObject(
      {
        example_sentence: {
          target_language: 'Jag ser ett **träd** i skogen.',
          english: 'I see a **tree** in the forest.',
          mother_tongue: 'Ich sehe einen **Baum** im Wald.',
        },
        explanation: 'A tall perennial plant with a single woody stem, branches, and leaves.',
      },
      {
        delay: 1000,
        matcher: (request) => {
          const body = request.postDataJSON() as { instructions?: string };
          return body?.instructions?.includes('Provide example sentence and explanation') ?? false;
        },
      },
    );

    page.on('console', (msg) => {
      console.log(`[browser:${msg.type()}]`, msg.text());
    });
    await env.setup();
    await page.goto(`${pluginUrl}/#/sidebar/translate`);
  });

  // test.afterEach(async () => {
  //   await env.teardown();
  // });

  test('translates with open page', async ({ page }) => {
    //fill and submit the word to be translated
    await page.getByRole('textbox', { name: 'snö, fog, Baum,....' }).fill('tree');
    await page.getByRole('button', { name: 'Look up word' }).click();

    //wait for basic translation to be completed
    await expect(page.getByText('ett')).toBeVisible();
    await expect(page.getByText('träd', { exact: true })).toBeVisible();
    await expect(page.getByText('(träd)')).toBeVisible();
    await expect(page.getByText('tree')).toBeVisible();
    await expect(page.locator('.h-4').first()).toBeVisible();
    await expect(page.locator('.h-4.bg-gray-700.rounded-md.animate-pulse.w-full')).toBeVisible();

    //wait for example sentence to be completed
    await expect(
      page.getByText('A tall perennial plant with a single woody stem, branches, and leaves.'),
    ).toBeVisible();
    await expect(page.getByText('Jag ser ett träd i skogen.')).toBeVisible();
    await expect(page.getByText('Ich sehe einen Baum im Wald.')).toBeVisible();
  });

  test('translates via side panel action event', async ({ page }) => {
    // Set up the listener BEFORE navigating so it's ready when the plugin calls onSidePanelAction
    await env.event.triggerOnSidePanelAction({
      plugin_id: pluginId,
      action_key: 'translate',
      action: 'translate',
      text: 'tree',
    });

    // Navigate to the page - the plugin will load and call onSidePanelAction, which will trigger our listener
    await page.goto(`${pluginUrl}/#/sidebar/translate`);

    await expect(page.getByText('ett')).toBeVisible();
    await expect(page.getByText('träd', { exact: true })).toBeVisible();

    await expect(
      page.getByText('A tall perennial plant with a single woody stem, branches, and leaves.'),
    ).toBeVisible();
    await expect(page.getByText('Jag ser ett träd i skogen.')).toBeVisible();
  });

  test('translates and resets the translator', async ({ page }) => {
    // Set up the listener BEFORE navigating so it's ready when the plugin calls onSidePanelAction
    await env.event.triggerOnSidePanelAction({
      plugin_id: pluginId,
      action_key: 'translate',
      action: 'translate',
      text: 'tree',
    });

    // Navigate to the page - the plugin will load and call onSidePanelAction, which will trigger our listener
    await page.goto(`${pluginUrl}/#/sidebar/translate`);

    // wait for basic translation to be completed
    await expect(page.getByText('ett')).toBeVisible();
    await expect(page.getByText('träd', { exact: true })).toBeVisible();

    // wait for full translation to be completed
    await expect(page.getByText('Jag ser ett träd i skogen.')).toBeVisible();

    // reset the translator
    await page.getByRole('button', { name: 'New translation' }).click();

    // wait for reset to be completed
    await expect(page.getByText('Translate')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'snö, fog, Baum,....' })).toBeVisible();
  });

  test('translates and ask question about the translation', async ({ page }) => {
    // Mock streaming text response for the chat/question feature
    await env.ai.mockGetSteamedText('This is a tree in Swedish: träd. It is an ett word.');

    // Set up the listener BEFORE navigating so it's ready when the plugin calls onSidePanelAction
    await env.event.triggerOnSidePanelAction({
      plugin_id: pluginId,
      action_key: 'translate',
      action: 'translate',
      text: 'tree',
    });

    // Navigate to the page - the plugin will load and call onSidePanelAction, which will trigger our listener
    await page.goto(`${pluginUrl}/#/sidebar/translate`);

    // wait for translation to be completed
    await expect(page.getByText('ett')).toBeVisible();
    await expect(page.getByText('träd', { exact: true })).toBeVisible();
    await expect(page.getByText('Jag ser ett träd i skogen.')).toBeVisible();

    // ask a question about the translation
    await page.getByRole('textbox', { name: 'Ask questions...' }).click();
    await page.getByRole('textbox', { name: 'Ask questions...' }).fill('What does that mean, explain in detail!');
    await page.getByRole('textbox', { name: 'Ask questions...' }).press('Enter');
    await expect(page.getByText('What does that mean, explain')).toBeVisible();

    // validate that ai response is visible
    await expect(page.getByText('This is a tree in Swedish: träd. It is an ett word.')).toBeVisible();
    // reset the translator and check that the ai chat is cleared
    await page.getByRole('button', { name: 'New translation' }).click();
    await page.getByRole('textbox', { name: 'snö, fog, Baum,....' }).fill('tree');
    await page.getByRole('button', { name: 'Look up word' }).click();
    await expect(page.getByText('ett')).toBeVisible();
    await page.getByText('Jag ser ett träd i skogen.').waitFor({ state: 'visible' });
    await expect(page.getByText('This is a tree in Swedish: träd. It is an ett word.')).not.toBeVisible();
  });
});
