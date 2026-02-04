import { config as loadEnv } from 'dotenv';
import { Browser, BrowserContext, ConsoleMessage, Page } from '@playwright/test';
import { completeStudyPlanGettingStarted } from '../helpers/e2e/study-plan-setup';
import { completeOnboarding } from '../helpers/e2e/onboarding';

loadEnv();

const RIMORI_URL = 'https://dev-app.rimori.se';
const BACKEND_URL = 'http://localhost:2800';
// const BACKEND_URL = 'https://dev-api.rimori.se';

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

export interface Onboarding {
  motivation_type?: string;
  preferred_genre?: string;
  target_country?: string;
  target_city?: string;
}

interface SetupOptions {
  onboarding?: Onboarding;
  exercises?: Array<Exercise>;
  studyPlan?: {
    complete: boolean;
  };
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

  async setup({ onboarding, exercises, studyPlan }: SetupOptions = {}): Promise<void> {
    const onboardingData = {
      motivation_type: onboarding?.motivation_type ?? 'accomplishment',
      preferred_genre: onboarding?.preferred_genre ?? 'comedy',
      target_country: onboarding?.target_country ?? 'SE',
      target_city: onboarding?.target_city ?? 'Malmö',
    };

    // Step 1: Create both test users (temp + persist) via API
    const { temp, persist } = await this.createTestUserViaApi();
    this.testUserEmail = temp.email;
    this.existingUserEmail = persist.email;
    console.log(`[E2E] Test user (temp): ${temp.email}`);
    console.log(`[E2E] Existing user (persist): ${persist.email}`);

    this.tempUserContext = await this.browser.newContext({ baseURL: RIMORI_URL });
    this.persistentUserContext = await this.browser.newContext({ baseURL: RIMORI_URL });

    await this.setupConsoleLogging(this.tempUserContext, 'temp');
    await this.setupConsoleLogging(this.persistentUserContext, 'persist');

    console.log(`[E2E] Preparing existing user context`);

    // Step 2: Set up existing user browser context with session via magic link
    await this.setSessionFromMagicLink(this.persistentUserContext, persist.magicLink);

    // Step 3: Run onboarding for existing user
    await this.completeOnboarding(this.persistentUserContext, onboardingData);

    console.log(`[E2E] Setting up test user context`);
    // Step 4: Set up test user browser context with session via magic link
    await this.setSessionFromMagicLink(this.tempUserContext, temp.magicLink);

    // Delete test user when test user context is closed
    this.tempUserContext.on('close', async () => {
      await this.deleteTestUserViaApi(temp.email);
      console.log(`[E2E] Deleted test user: ${temp.email}`);
    });

    // Step 5: Run onboarding for test user with e2e plugin flag
    await this.completeOnboarding(this.tempUserContext, onboardingData, this.pluginId);

    // Step 6: Add exercises if specified
    if (exercises && exercises?.length > 0) {
      console.log(`[E2E] Setting up exercises`);
      await this.completeExerciseSetup(this.tempUserContext, exercises);
    }

    // Step 7: Complete study plan creation if specified
    if (studyPlan?.complete) {
      console.log(`[E2E] Setting up study plan`);
      await this.completeStudyPlanCreation(this.tempUserContext);
    }
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
      console.log(`[browser:${logLevel}] [${user}]`, logMessage);
    });
  }

  private async setSessionFromMagicLink(context: BrowserContext, magicLink: string): Promise<void> {
    const page = await context.newPage();
    await page.goto(magicLink, { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);

    const url = page.url();
    if (!url.includes('/dashboard') && !url.includes('/onboarding')) {
      throw new Error(`Failed to set session from magic link: ${url}`);
    }

    await page.close();
    console.log(`[E2E] Authentication completed`);
  }

  private async completeOnboarding(
    context: BrowserContext,
    onboarding: Required<Onboarding>,
    e2ePluginId?: string,
  ): Promise<void> {
    console.log(`[E2E] Starting onboarding`);
    const page = await context.newPage();
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
    await page.close();
  }

  private async completeExerciseSetup(context: BrowserContext, exercises: Array<Exercise>): Promise<void> {
    const page = await context.newPage();
    for (const exercise of exercises) {
      const encoded = encodeURIComponent(JSON.stringify(exercise));
      await page.goto(`${RIMORI_URL}/dashboard?flag-e2e-exercise=${encoded}`);
      // Wait for the exercise to be created and the flag to be cleared from URL
      await page.waitForURL((url) => !url.searchParams.has('flag-e2e-exercise'), { timeout: 15000 });
    }
    await page.close();
  }

  private async completeStudyPlanCreation(context: BrowserContext): Promise<void> {
    const page = await context.newPage();
    await completeStudyPlanGettingStarted(page);
    await page.close();
  }
}
