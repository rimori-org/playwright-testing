import { config as loadEnv } from 'dotenv';
import { Browser, BrowserContext, ConsoleMessage, Page } from '@playwright/test';
import { completeOnboarding, Onboarding } from '../helpers/e2e/onboarding';
import { createExerciseViaDialog } from '../helpers/e2e/create-exercise';

loadEnv();

const RIMORI_URL = 'https://dev-app.rimori.se';
// const BACKEND_URL = 'http://localhost:2800';
const BACKEND_URL = 'https://dev-api.rimori.se';

interface RimoriE2ETestEnvironmentOptions {
  browser: Browser;
  pluginId: string;
}

interface Exercise {
  title: string;
  description: string;
  pluginId: string;
  actionKey: string;
  parameters?: Record<string, unknown>;
}


interface SetupOptions {
  onboarding?: Onboarding;
  exercises?: Array<Exercise>;
}

interface CreateTestUserResponse {
  temp: {
    email: string;
    magicLink: string;
    expiresAt: string;
  };
  persist: {
    email: string;
    magicLink: string;
  };
}

export class RimoriE2ETestEnvironment {
  private browser: Browser;
  private pluginId: string;

  private persistentUserContext: BrowserContext | null = null;
  private tempUserContext: BrowserContext | null = null;
  private testUserEmail: string | null = null;
  private existingUserEmail: string | null = null;
  private authToken: string | null = null;

  constructor(options: RimoriE2ETestEnvironmentOptions) {
    this.browser = options.browser;
    this.pluginId = options.pluginId;
    this.authToken = process.env.RIMORI_TOKEN ?? '';
    if (!this.authToken) {
      throw new Error('RIMORI_TOKEN is not set as an environment variable.');
    }
  }

  async setup({ onboarding, exercises }: SetupOptions = {}): Promise<void> {
    const onboardingData: Required<Onboarding> = {
      learning_reason: onboarding?.learning_reason ?? 'work',
      target_country: onboarding?.target_country ?? 'SE',
      target_city: onboarding?.target_city ?? 'Malmö',
      interests: onboarding?.interests ?? 'Travel, cooking, and music',
    };

    // Step 1: Create both test users (temp + persist) via API
    const { temp, persist } = await this.createTestUserViaApi();
    this.testUserEmail = temp.email;
    this.existingUserEmail = persist.email;
    console.log(`[E2E] Test user (temp): ${temp.email}`);
    console.log(`[E2E] Existing user (persist): ${persist.email}`);

    this.persistentUserContext = await this.browser.newContext({ baseURL: RIMORI_URL });
    
    await this.setupConsoleLogging(this.persistentUserContext, 'persist');
    
    console.log(`[E2E] Preparing existing user context`);
    const persistPage = await this.persistentUserContext.newPage();
    
    // Step 2: Set up existing user browser context with session via magic link
    await this.setSessionFromMagicLink(persistPage, persist.magicLink);
    
    // Step 3: Run onboarding for existing user
    await this.completeOnboarding(persistPage, onboardingData);
    
    persistPage.close();
    
    console.log(`[E2E] Setting up test user context`);
    
    this.tempUserContext = await this.browser.newContext({ baseURL: RIMORI_URL });
    await this.setupConsoleLogging(this.tempUserContext, 'temp');
    const tempPage = await this.tempUserContext.newPage();

    // Step 4: Set up test user browser context with session via magic link
    await this.setSessionFromMagicLink(tempPage, temp.magicLink);

    // Delete test user when test user context is closed
    this.tempUserContext.on('close', async () => {
      await this.deleteTestUserViaApi(temp.email);
      console.log(`[E2E] Deleted test user: ${temp.email}`);
    });

    // Step 5: Run onboarding for test user with e2e plugin flag
    await this.completeOnboarding(tempPage, onboardingData, this.pluginId);

    // Step 6: Add exercises if specified
    if (exercises && exercises?.length > 0) {
      console.log(`[E2E] Setting up exercises`);
      await this.completeExerciseSetup(tempPage, exercises);
    }

    tempPage.close();
    console.log(`[E2E] Setup completed`);
  }

  async getTempUserPage(): Promise<Page> {
    if (!this.tempUserContext) {
      throw new Error('Test user context not initialized. Call setup() first.');
    }
    return this.tempUserContext.newPage();
  }

  async getPersistUserPage(): Promise<Page> {
    if (!this.persistentUserContext) {
      throw new Error('Existing user context not initialized. Call setup() first.');
    }
    return this.persistentUserContext.newPage();
  }

  getTempUserEmail(): string {
    if (!this.testUserEmail) {
      throw new Error('Test user not created. Call setup() first.');
    }
    return this.testUserEmail;
  }

  getPersistUserEmail(): string {
    if (!this.existingUserEmail) {
      throw new Error('Existing user not created. Call setup() first.');
    }
    return this.existingUserEmail;
  }

  private async createTestUserViaApi(): Promise<CreateTestUserResponse> {
    const response = await fetch(`${BACKEND_URL}/testing/test-user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({
        plugin_id: this.pluginId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create test user: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  private async deleteTestUserViaApi(email: string): Promise<void> {
    const response = await fetch(`${BACKEND_URL}/testing/test-user`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({
        plugin_id: this.pluginId,
        email,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete test user: ${response.status} ${errorText}`);
    }
  }

  private async setupConsoleLogging(context: BrowserContext, user: string): Promise<void> {
    console.log(`[E2E] Setting up console logging for ${user}`);
    context.on('console', (msg: ConsoleMessage) => {
      const logLevel = msg.type();
      const logMessage = msg.text();
      if (logLevel === 'debug') return;

      if (logMessage.includes('Download the React DevTools')) return;
      if (logMessage.includes('languageChanged en')) return;
      if (logMessage.includes('i18next: initialized {debug: true')) return;
      if (logMessage.includes('i18next is maintained')) return;
      console.log(`[browser:${logLevel}] [${user}]`, logMessage);
    });
  }

  private async setSessionFromMagicLink(page: Page, magicLink: string): Promise<void> {
    await page.goto(magicLink, { waitUntil: 'networkidle' });

    try {
      await page.waitForURL(
        (url) => url.pathname.includes('/dashboard') || url.pathname.includes('/onboarding'),
        { timeout: 30000 },
      );
    } catch {
      const url = page.url();
      throw new Error(`Failed to set session from magic link: ${url}`);
    }

    console.log(`[E2E] Authentication completed`);
  }

  private async completeOnboarding(
    page: Page,
    onboarding: Required<Onboarding>,
    e2ePluginId?: string,
  ): Promise<void> {
    console.log(`[E2E] Starting onboarding`);
    await page.goto('/onboarding');
    await page.waitForTimeout(5000);
    const isOnboaded = page.url().includes('/dashboard');
    if (!isOnboaded) {
      console.log(`[E2E] Onboarding user`);
      await completeOnboarding(page, onboarding, e2ePluginId);
      console.log(`[E2E] Onboarding completed`);
    } else {
      console.log(`[E2E] User already onboarded`);
    }
  }

  private async completeExerciseSetup(page: Page, exercises: Array<Exercise>): Promise<void> {
    for (const exercise of exercises) {
      await createExerciseViaDialog(page, exercise);
    }
  }
}

// test
