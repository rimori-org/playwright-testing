import { Page, Route, Request, ConsoleMessage } from '@playwright/test';
import { RimoriInfo } from '@rimori/client/dist/plugin/CommunicationHandler';
import { UserInfo } from '@rimori/client/dist/controller/SettingsController';
import { MainPanelAction, Plugin } from '@rimori/client/dist/fromRimori/PluginTypes';
import { DEFAULT_USER_INFO } from '../fixtures/default-user-info';
import { MessageChannelSimulator } from './MessageChannelSimulator';
import { SettingsStateManager, PluginSettings } from './SettingsStateManager';
import { EventPayload } from '@rimori/client/dist/fromRimori/EventBus';
import { LanguageLevel } from '@rimori/client';

interface RimoriTestEnvironmentOptions {
  page: Page;
  pluginId: string;
  pluginUrl: string;
  settings?: PluginSettings;
  queryParams?: Record<string, string>;
  userInfo?: Partial<UserInfo>;
  installedPlugins?: Plugin[];
  guildOverrides?: Record<string, unknown>;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface MockOptions {
  /*
   * @param errorCode Optional error code. Defaults to `failed`, could be one of the following:
   * - `'aborted'` - An operation was aborted (due to user action)
   * - `'accessdenied'` - Permission to access a resource, other than the network, was denied
   * - `'addressunreachable'` - The IP address is unreachable. This usually means that there is no route to the
   * specified host or network.
   * - `'blockedbyclient'` - The client chose to block the request.
   * - `'blockedbyresponse'` - The request failed because the response was delivered along with requirements which are
   * not met ('X-Frame-Options' and 'Content-Security-Policy' ancestor checks, for instance).
   * - `'connectionaborted'` - A connection timed out as a result of not receiving an ACK for data sent.
   * - `'connectionclosed'` - A connection was closed (corresponding to a TCP FIN).
   * - `'connectionfailed'` - A connection attempt failed.
   * - `'connectionrefused'` - A connection attempt was refused.
   * - `'connectionreset'` - A connection was reset (corresponding to a TCP RST).
   * - `'internetdisconnected'` - The Internet connection has been lost.
   * - `'namenotresolved'` - The host name could not be resolved.
   * - `'timedout'` - An operation timed out.
   * - `'failed'` - A generic failure occurred.
   * */
  error?:
    | 'aborted'
    | 'accessdenied'
    | 'addressunreachable'
    | 'blockedbyclient'
    | 'blockedbyresponse'
    | 'connectionaborted'
    | 'connectionclosed'
    | 'connectionfailed'
    | 'connectionrefused'
    | 'connectionreset'
    | 'internetdisconnected'
    | 'namenotresolved'
    | 'timedout';
  /**
   * The delay in milliseconds before the response is returned.
   */
  delay?: number;
  /**
   * Optional matcher function to determine if this mock should be used for the request.
   * If provided, the mock will only be used if the matcher returns true.
   * If multiple mocks match, the first one in the array will be used.
   */
  matcher?: (request: Request) => boolean;
  /**
   * The HTTP method for the route. If not provided, defaults will be used based on the route type.
   */
  method?: HttpMethod;
  /**
   * If true, the mock is removed after first use. Default: false (persistent).
   * This allows for sequential mock responses where each mock is consumed once.
   * Useful for testing flows where the same route is called multiple times with different responses.
   */
  once?: boolean;
}

interface MockRecord {
  value: unknown | ((request: Request) => unknown | Promise<unknown>); // Can be a function that receives the request
  method: HttpMethod;
  options?: MockOptions;
  isStreaming?: boolean; // Flag to indicate if this is a streaming response
}

export class RimoriTestEnvironment {
  private readonly page: Page;
  private readonly pluginId: string;

  private rimoriInfo: RimoriInfo;
  private backendRoutes: Record<string, MockRecord[]> = {};
  private supabaseRoutes: Record<string, MockRecord[]> = {};
  private messageChannelSimulator: MessageChannelSimulator | null = null;
  private settingsManager: SettingsStateManager;

  public constructor(options: RimoriTestEnvironmentOptions) {
    this.page = options.page;
    this.pluginId = options.pluginId;

    this.rimoriInfo = this.getRimoriInfo(options);

    // Initialize settings state manager
    this.settingsManager = new SettingsStateManager(
      options.settings || null,
      options.pluginId,
      this.rimoriInfo.guild.id,
    );

    this.interceptRoutes(options.pluginUrl);
  }

  private interceptRoutes(pluginUrl: string): void {
    // Intercept all /locales requests and fetch from the dev server
    this.page.route(`${pluginUrl}/locales/**`, async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());

      const devServerUrl = `http://${url.host}/locales/en.json`;
      // console.log('Fetching locales from: ' + devServerUrl);

      // throw new Error('Test: ' + devServerUrl);

      try {
        // Fetch from the dev server
        const response = await fetch(devServerUrl);
        const body = await response.text();

        await route.fulfill({
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      } catch (error) {
        console.error(`Error fetching translation from ${devServerUrl}:`, error);
        await route.fulfill({
          status: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Failed to load translations' }),
        });
      }
    });
    this.page.route(`${this.rimoriInfo.backendUrl}/**`, (route: Route) => this.handleRoute(route, this.backendRoutes));
    this.page.route(`${this.rimoriInfo.url}/**`, (route: Route) => this.handleRoute(route, this.supabaseRoutes));
  }

  public async setup(): Promise<void> {
    // console.log('Setting up RimoriTestEnvironment');

    this.page.on('console', (msg: ConsoleMessage) => {
      const logLevel = msg.type();
      const logMessage = msg.text();
      if (logLevel === 'debug') return;

      if (logMessage.includes('Download the React DevTools')) return;
      if (logMessage.includes('languageChanged en')) return;
      if (logMessage.includes('i18next: initialized {debug: true')) return;
      console.log(`[browser:${logLevel}]`, logMessage);
    });

    // Set up default handlers for plugin_settings routes using SettingsStateManager
    this.setupSettingsRoutes();

    // Set up default handlers for shared_content routes
    this.setupSharedContentRoutes();

    // Initialize MessageChannelSimulator to simulate parent-iframe communication
    // This makes the plugin think it's running in an iframe (not standalone mode)
    // Convert RimoriInfo from CommunicationHandler format to MessageChannelSimulator format
    this.messageChannelSimulator = new MessageChannelSimulator({
      page: this.page,
      pluginId: this.pluginId,
      queryParams: {},
      rimoriInfo: this.rimoriInfo,
    });

    // Initialize the simulator - this injects the necessary shims
    // to intercept window.parent.postMessage calls and set up MessageChannel communication
    await this.messageChannelSimulator.initialize();

    // Set up a no-op handler for pl454583483.session.triggerUrlChange
    // This prevents errors if the plugin emits this event
    this.messageChannelSimulator.on(`${this.pluginId}.session.triggerUrlChange`, () => {
      // No-op handler - does nothing
    });
    this.messageChannelSimulator.on(`${this.pluginId}.session.triggerScrollbarChange`, () => {
      // No-op handler - does nothing
    });
    this.messageChannelSimulator.on('global.accomplishment.triggerMicro', () => {
      // No-op handler - does nothing
    });
    this.messageChannelSimulator.on('global.accomplishment.triggerMacro', () => {
      // No-op handler - does nothing
    });
  }

  private getRimoriInfo(options: RimoriTestEnvironmentOptions): RimoriInfo {
    // Merge userInfo with DEFAULT_USER_INFO, with userInfo taking precedence
    // Deep merge nested objects first, then spread the rest
    const mergedUserInfo: UserInfo = {
      ...DEFAULT_USER_INFO,
      ...(options.userInfo?.mother_tongue && {
        mother_tongue: {
          ...DEFAULT_USER_INFO.mother_tongue,
          ...options.userInfo.mother_tongue,
        },
      }),
      ...(options.userInfo?.target_language && {
        target_language: {
          ...DEFAULT_USER_INFO.target_language,
          ...options.userInfo.target_language,
        },
      }),
      ...(options.userInfo?.study_buddy && {
        study_buddy: {
          ...DEFAULT_USER_INFO.study_buddy,
          ...options.userInfo.study_buddy,
        },
      }),
      // Spread the rest of userInfo after deep merging nested objects
      ...Object.fromEntries(
        Object.entries(options.userInfo || {}).filter(
          ([key]) => !['mother_tongue', 'target_language', 'study_buddy'].includes(key),
        ),
      ),
    };

    return {
      key: 'rimori-testing-key',
      token: 'rimori-testing-token',
      url: 'http://localhost:3500',
      backendUrl: 'http://localhost:3501',
      expiration: new Date(Date.now() + 60 * 60 * 1000),
      tablePrefix: options.pluginId,
      pluginId: options.pluginId,
      guild: {
        id: 'guild-test-id',
        // @ts-ignore
        name: 'Test Guild',
        city: 'Test City',
        country: 'Testland',
        description: 'A dummy guild used for testing purposes.',
        // @ts-ignore
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
        inviteCode: 'INVITE123',
        isPublic: true,
        isShadowGuild: false,
        allowUserPluginSettings: true,
        primaryLanguage: 'en',
        ownerId: 'test-owner-user-id',
        scope: 'test-scope',
        longTermGoalOverride: '',
      },
      installedPlugins: options.installedPlugins ?? [],
      profile: mergedUserInfo,
      mainPanelPlugin: undefined,
      sidePanelPlugin: undefined,
      interfaceLanguage: mergedUserInfo.mother_tongue.code, // Set interface language from user's mother tongue
    };
  }

  /**
   * Sets up the plugin_settings routes to use the SettingsStateManager.
   * GET returns current state, PATCH updates state, POST creates/updates state.
   */
  private setupSettingsRoutes(): void {
    // GET: Return current settings state
    this.addSupabaseRoute('plugin_settings', () => this.settingsManager.getSettings(), {
      method: 'GET',
    });

    // PATCH: Update settings based on request body
    this.addSupabaseRoute(
      'plugin_settings',
      async (request: Request) => {
        try {
          const postData = request.postData();
          if (postData) {
            const updates = JSON.parse(postData) as Partial<PluginSettings>;
            return this.settingsManager.updateSettings(updates);
          }
          // If no body, return empty array (no update)
          return this.settingsManager.updateSettings({});
        } catch {
          // If parsing fails, return empty array
          return this.settingsManager.updateSettings({});
        }
      },
      {
        method: 'PATCH',
      },
    );

    // POST: Insert/update settings based on request body
    this.addSupabaseRoute(
      'plugin_settings',
      async (request: Request) => {
        try {
          const postData = request.postData();
          if (postData) {
            const newSettings = JSON.parse(postData) as Partial<PluginSettings>;
            return this.settingsManager.insertSettings(newSettings);
          }
          // If no body, insert with defaults
          return this.settingsManager.insertSettings({});
        } catch {
          // If parsing fails, insert with defaults
          return this.settingsManager.insertSettings({});
        }
      },
      {
        method: 'POST',
      },
    );
  }

  /**
   * Sets up default handlers for shared content routes.
   * Note: Shared content tables are now plugin-specific with format: `${pluginId}_sc_${tableName}`
   * This method no longer sets up generic routes since each plugin has its own tables.
   * Use the community.sharedContent mock methods to set up specific table mocks.
   */
  private setupSharedContentRoutes(): void {
    // No longer setting up generic routes - each plugin has its own prefixed tables
    // Tests should use env.community.sharedContent.mock* methods for specific tables
  }

  /**
   * Formats text as SSE (Server-Sent Events) response.
   * Since Playwright's route.fulfill() requires complete body, we format as SSE without delays.
   */
  private formatAsSSE(text: string): string {
    const chunks: string[] = [];

    // Start event
    chunks.push(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

    // Text start event
    chunks.push(`data: ${JSON.stringify({ type: 'text-start', id: '1' })}\n\n`);

    // Text delta events (one chunk per character for simplicity)
    for (let i = 0; i < text.length; i++) {
      chunks.push(`data: ${JSON.stringify({ type: 'text-delta', delta: text[i] })}\n\n`);
    }

    // Text end event
    chunks.push(`data: ${JSON.stringify({ type: 'text-end', id: '1' })}\n\n`);

    // Finish event
    chunks.push(`data: ${JSON.stringify({ type: 'finish' })}\n\n`);

    // Done marker
    chunks.push('data: [DONE]\n\n');

    return chunks.join('');
  }

  /**
   * Normalizes a URL by removing query parameters and fragments for consistent matching.
   */
  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      return `${urlObj.origin}${urlObj.pathname}`;
    } catch {
      return url;
    }
  }

  /**
   * Creates a route key combining HTTP method and normalized URL.
   */
  private createRouteKey(method: HttpMethod, url: string): string {
    const normalizedUrl = this.normalizeUrl(url);
    return `${method} ${normalizedUrl}`;
  }

  /**
   * Removes a one-time mock from the mocks array after it's been used.
   */
  private removeOneTimeMock(mock: MockRecord, mocks: MockRecord[]): void {
    if (!mock.options?.once) return;
    const index = mocks.indexOf(mock);
    if (index > -1) {
      mocks.splice(index, 1);
    }
  }

  /**
   * Creates a wrapper around the Playwright Request object that provides backwards compatibility
   * for matchers. The new rimori-client sends `messages` array instead of `instructions`,
   * so this wrapper extracts the prompts from messages and provides them as `instructions`.
   *
   * The old API had a single `instructions` field which typically contained the user's specific
   * instruction (what the AI should do). The new API splits this into:
   * - systemPrompt (messages[0] with role='system'): High-level behavior instructions
   * - userPrompt (messages[1] with role='user'): Specific task instruction
   *
   * For backwards compatibility, we concatenate all message contents into `instructions`.
   */
  private createBackwardsCompatibleRequest(originalRequest: Request): Request {
    // Create a proxy that intercepts postDataJSON calls
    return new Proxy(originalRequest, {
      get(target, prop) {
        if (prop === 'postDataJSON') {
          return () => {
            try {
              const body = target.postDataJSON();
              if (body && body.messages && Array.isArray(body.messages) && !body.instructions) {
                // Concatenate all message contents for backwards compatibility
                // This allows matchers to check for text that might be in either system or user prompts
                const allContent = body.messages
                  .map((m: { role: string; content?: string }) => m.content || '')
                  .filter((content: string) => content.length > 0)
                  .join('\n');

                if (allContent) {
                  return { ...body, instructions: allContent };
                }
              }
              return body;
            } catch {
              return null;
            }
          };
        }
        // For all other properties, return the original value bound to the target
        const value = (target as any)[prop];
        if (typeof value === 'function') {
          return value.bind(target);
        }
        return value;
      },
    });
  }

  private async handleRoute(route: Route, routes: Record<string, MockRecord[]>): Promise<void> {
    const request = route.request();
    const requestUrl = request.url();
    const method = request.method().toUpperCase() as HttpMethod;
    const routeKey = this.createRouteKey(method, requestUrl);
    // console.log('Handling route', routeKey);

    const mocks = routes[routeKey];
    if (!mocks || mocks.length === 0) {
      console.error('No route handler found for route', routeKey);
      throw new Error('No route handler found for route: ' + routeKey);
      route.abort('not_found');
      return;
    }

    // Create backwards-compatible request wrapper for matchers
    const compatRequest = this.createBackwardsCompatibleRequest(request);

    // Find the first matching mock based on matcher function
    // Priority: mocks with matchers that match > mocks without matchers (as fallback)
    let matchingMock: MockRecord | undefined;
    let fallbackMock: MockRecord | undefined;

    for (const mock of mocks) {
      if (mock.options?.matcher) {
        try {
          // Use the backwards-compatible request wrapper for matchers
          if (mock.options.matcher(compatRequest)) {
            matchingMock = mock;
            break;
          }
        } catch (error) {
          console.error('Error in matcher function:', error);
        }
      } else if (!fallbackMock) {
        // Keep the first mock without a matcher as fallback
        fallbackMock = mock;
      }
    }

    // Use matching mock if found, otherwise use fallback
    matchingMock = matchingMock ?? fallbackMock;

    if (!matchingMock) {
      console.error('No matching mock found for route', routeKey);
      route.abort('not_found');
      return;
    }

    // Handle the matched mock
    const options = matchingMock.options;
    await new Promise((resolve) => setTimeout(resolve, options?.delay ?? 0));

    // Remove one-time mock after handling (before responding)
    this.removeOneTimeMock(matchingMock, mocks);

    if (options?.error) {
      return await route.abort(options.error);
    }

    // Handle function-based mocks (for stateful responses like settings)
    let responseValue = matchingMock.value;
    if (typeof matchingMock.value === 'function') {
      responseValue = await matchingMock.value(request);
    }

    // Handle streaming responses (for mockGetSteamedText and mockGetStreamedObject)
    // Since Playwright requires complete body, we format as SSE without delays
    if (matchingMock.isStreaming) {
      let body: string;

      if (typeof responseValue === 'string') {
        // Text streaming (mockGetSteamedText)
        body = this.formatAsSSE(responseValue);
      } else {
        // Object streaming (mockGetStreamedObject)
        // Format as SSE with JSON payload, followed by [DONE] marker
        body = `data: ${JSON.stringify(responseValue)}\n\ndata: [DONE]\n\n`;
      }

      return await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body,
      });
    }

    // Regular JSON response
    const responseBody = JSON.stringify(responseValue);

    route.fulfill({
      status: 200,
      body: responseBody,
    });
  }

  /**
   * Adds a supabase route to the supabase routes object.
   * @param path - The path of the route.
   * @param values - The values to return in the response.
   * @param options - The options for the route. Method defaults to 'GET' if not specified.
   */
  private addSupabaseRoute(path: string, values: unknown, options?: MockOptions): void {
    const method = options?.method ?? 'GET';
    const fullPath = `${this.rimoriInfo.url}/rest/v1/${path}`;
    const routeKey = this.createRouteKey(method, fullPath);
    // console.log('Registering supabase route:', routeKey);
    if (!this.supabaseRoutes[routeKey]) {
      this.supabaseRoutes[routeKey] = [];
    }
    this.supabaseRoutes[routeKey].push({
      value: values,
      method,
      options,
    });
  }

  /**
   * Adds a backend route to the backend routes object.
   * @param path - The path of the route.
   * @param values - The values to return in the response.
   * @param options - The options for the route. Method defaults to 'POST' if not specified.
   * @param isStreaming - Optional flag to mark this as a streaming response.
   */
  private addBackendRoute(path: string, values: unknown, options?: MockOptions & { isStreaming?: boolean }): void {
    const method = options?.method ?? 'POST';
    const fullPath = `${this.rimoriInfo.backendUrl}${path.startsWith('/') ? path : '/' + path}`;
    const routeKey = this.createRouteKey(method, fullPath);
    if (!this.backendRoutes[routeKey]) {
      this.backendRoutes[routeKey] = [];
    }
    const { isStreaming, ...mockOptions } = options || {};
    this.backendRoutes[routeKey].push({
      value: values,
      method,
      options: mockOptions,
      isStreaming: isStreaming ?? false,
    });
  }

  public readonly plugin = {
    /**
     * Manually set the settings state (useful for test setup).
     * This directly modifies the internal settings state.
     * @param settings - The settings to set, or null to clear settings
     */
    setSettings: (settings: PluginSettings | null) => {
      this.settingsManager.setSettings(settings);
    },
    /**
     * Get the current settings state (useful for assertions).
     * @returns The current settings or null if no settings exist
     */
    getSettings: (): PluginSettings | null => {
      return this.settingsManager.getSettings();
    },
    /**
     * Override the GET handler for plugin_settings (rarely needed).
     * By default, GET returns the current state from SettingsStateManager.
     */
    mockGetSettings: (settingsRow: PluginSettings | null, options?: MockOptions) => {
      this.addSupabaseRoute('plugin_settings', settingsRow, { ...options, method: 'GET' });
    },
    /**
     * Override the PATCH handler for plugin_settings (rarely needed).
     * By default, PATCH updates the state in SettingsStateManager.
     */
    mockSetSettings: (response: unknown, options?: MockOptions) => {
      this.addSupabaseRoute('plugin_settings', response, { ...options, method: 'PATCH' });
    },
    /**
     * Override the POST handler for plugin_settings (rarely needed).
     * By default, POST inserts/updates the state in SettingsStateManager.
     */
    mockInsertSettings: (response: unknown, options?: MockOptions) => {
      this.addSupabaseRoute('plugin_settings', response, { ...options, method: 'POST' });
    },
    mockGetUserInfo: (userInfo: Partial<UserInfo>, options?: MockOptions) => {
      // Update the rimoriInfo.profile so that MessageChannelSimulator returns the correct user info
      this.rimoriInfo.profile = { ...this.rimoriInfo.profile, ...userInfo };
      // Also update the MessageChannelSimulator if it exists (setup() has been called)
      if (this.messageChannelSimulator) {
        this.messageChannelSimulator.setUserInfo(this.rimoriInfo.profile);
      }
      this.addSupabaseRoute('/user-info', this.rimoriInfo.profile, { ...options, delay: 0 });
    },
    mockGetPluginInfo: (pluginInfo: Plugin, options?: MockOptions) => {
      this.addSupabaseRoute('/plugin-info', pluginInfo, options);
    },
  };

  public readonly db = {
    /**
     * Mocks a Supabase table endpoint (from(tableName)).
     * The table name will be prefixed with the plugin ID in the actual URL.
     *
     * Supabase operations map to HTTP methods as follows:
     * - .select() → GET
     * - .insert() → POST
     * - .update() → PATCH
     * - .delete() → DELETE (can return data with .delete().select())
     * - .upsert() → POST
     *
     * @param tableName - The table name (e.g., 'decks')
     * @param value - The response value to return for the request
     * @param options - Mock options including HTTP method (defaults to 'GET' if not specified)
     */
    mockFrom: (tableName: string, value: unknown, options?: MockOptions) => {
      // console.log('Mocking db.from for table:', tableName, 'method:', options?.method ?? 'GET', value, options);

      const fullTableName = `${this.pluginId}_${tableName}`;
      this.addSupabaseRoute(fullTableName, value, options);
    },
  };

  public readonly event = {
    /**
     * Emit an event into the plugin as if it came from Rimori main or another plugin.
     *
     * Note: This does NOT currently reach worker listeners such as those in
     * `worker/listeners/decks.ts` or `worker/listeners/flascards.ts` – those run in a
     * separate process. This helper is intended for UI‑side events only.
     */
    mockEmit: async (topic: string, data: EventPayload, sender = 'test'): Promise<void> => {
      if (!this.messageChannelSimulator) {
        throw new Error('MessageChannelSimulator not initialized. Call setup() first.');
      }
      await this.messageChannelSimulator.emit(topic, data, sender);
    },
    /**
     * Registers a persistent auto-responder for request/response style events.
     *
     * When the plugin calls `plugin.event.request(topic, data)`, this registered responder
     * will automatically return the provided response value. The responder persists and
     * will respond to multiple requests until manually removed.
     *
     * Example:
     * ```ts
     * // Register a responder that will return deck summaries when requested
     * env.event.mockRequest('deck.requestOpenToday', [
     *   { id: 'deck-1', name: 'My Deck', total_new: 5, total_learning: 2, total_review: 10 }
     * ]);
     *
     * // Now when the plugin calls: plugin.event.request('deck.requestOpenToday', {})
     * // It will receive the deck summaries array above (can be called multiple times)
     * ```
     *
     * @param topic - The event topic to respond to (e.g., 'deck.requestOpenToday')
     * @param response - The response value to return, or a function that receives the event and returns the response
     * @returns A function to manually remove the responder
     */
    mockRequest: (topic: string, response: unknown | ((event: unknown) => unknown)) => {
      if (!this.messageChannelSimulator) {
        throw new Error('MessageChannelSimulator not initialized. Call setup() first.');
      }
      return this.messageChannelSimulator.respond(topic, response);
    },
    /**
     * Listen for events emitted by the plugin.
     * @param topic - The event topic to listen for (e.g., 'global.accomplishment.triggerMicro')
     * @param handler - The handler function that receives the event data
     * @returns A function to unsubscribe from the event
     */
    on: (topic: string, handler: (data: unknown) => void): (() => void) => {
      if (!this.messageChannelSimulator) {
        throw new Error('MessageChannelSimulator not initialized. Call setup() first.');
      }
      return this.messageChannelSimulator.on(topic, (event) => {
        handler(event.data);
      });
    },
    mockOnce: () => {},
    mockRespond: () => {},
    mockEmitAccomplishment: () => {},
    mockOnAccomplishment: () => {},
    /**
     * Emits a sidebar action event into the plugin as if Rimori main had triggered it.
     * This is useful for testing sidebar-driven flows like flashcard creation from selected text.
     *
     * It sends a message on the 'global.sidebar.triggerAction' topic, which plugins can listen to via:
     *   plugin.event.on<{ action: string; text: string }>('global.sidebar.triggerAction', ...)
     *
     * @param payload - The payload forwarded to the plugin, typically including an `action` key and optional `text`.
     */
    triggerSidebarAction: async (payload: { action: string; text?: string }) => {
      if (!this.messageChannelSimulator) {
        throw new Error('MessageChannelSimulator not initialized. Call setup() first.');
      }

      // Simulate Rimori main emitting the sidebar trigger event towards the plugin
      await this.messageChannelSimulator.emit('global.sidebar.triggerAction', payload, 'sidebar');
    },
    /**
     * Triggers a side panel action event as the parent application would.
     * This simulates how rimori-main's SidebarPluginHandler responds to plugin's 'action.requestSidebar' events.
     * @param payload - The action payload containing plugin_id, action_key, and action parameters
     */
    triggerOnSidePanelAction: async (payload: MainPanelAction) => {
      if (!this.messageChannelSimulator) {
        throw new Error('MessageChannelSimulator not initialized. Call setup() first.');
      }

      const topic = `${this.pluginId}.action.requestSidebar`;

      const actionPayload = payload;
      const off = this.messageChannelSimulator.on(topic, async (event) => {
        await this.messageChannelSimulator!.emit(topic, actionPayload, 'sidebar');
        off();
      });
    },
    /**
     * Triggers a main panel action event as the parent application would.
     * This simulates how rimori-main's MainPluginHandler uses EventBus.respond to respond
     * to plugin's 'action.requestMain' events. When the plugin calls onMainPanelAction(),
     * it emits '{pluginId}.action.requestMain' and listens for the response.
     * This method sets up a responder that automatically responds when the plugin emits this event.
     * @param payload - The main panel action payload containing plugin_id, action_key, and action parameters
     */
    triggerOnMainPanelAction: async (payload: MainPanelAction) => {
      if (!this.messageChannelSimulator) {
        throw new Error('MessageChannelSimulator not initialized. Call setup() first.');
      }

      // Listen for when the plugin emits 'action.requestMain' (which becomes '{pluginId}.action.requestMain')
      // and respond with the MainPanelAction payload, matching rimori-main's EventBus.respond behavior
      const topic = `${this.pluginId}.action.requestMain`;

      // Store the payload in a closure so we can respond with it
      const actionPayload = payload;

      // Register a persistent auto-responder (not respondOnce) because the plugin may
      // emit this event multiple times during its lifecycle. Using respondOnce would
      // only respond to the first request and ignore subsequent ones.
      this.messageChannelSimulator.respond(topic, actionPayload);
    },
  };

  public readonly ai = {
    /**
     * Mocks a text response from the LLM endpoint.
     * Since getText now uses streamObject internally with a { result: string } schema,
     * the mock value should be the full response object.
     *
     * @param values - The response object to return. Should include { result: string } for getText calls.
     * @param options - Optional mock options.
     */
    mockGetText: (values: unknown, options?: MockOptions) => {
      this.addBackendRoute('/ai/llm', values, { ...options, isStreaming: true });
    },
    /**
     * Mocks a streaming text response from the LLM endpoint.
     * The new rimori-client's getSteamedText uses streamObject internally with { result: string } schema,
     * so the text is wrapped in a result object.
     *
     * **Note**: Due to Playwright's route.fulfill() requiring a complete response body,
     * all SSE chunks are sent at once (no delays). The client will still parse it as SSE correctly.
     *
     * @param text - The text to stream. Will be wrapped as { result: text } and formatted as SSE.
     * @param options - Optional mock options.
     */
    mockGetSteamedText: (text: string, options?: MockOptions) => {
      // Wrap text in result object as the new client expects { result: string }
      this.addBackendRoute('/ai/llm', { result: text }, { ...options, isStreaming: true });
    },
    mockGetVoice: (values: Buffer, options?: MockOptions) => {
      this.addBackendRoute('/voice/tts', values, options);
    },
    mockGetTextFromVoice: (text: string, options?: MockOptions) => {
      this.addBackendRoute('/voice/stt', text, options);
    },
    /**
     * Mocks an object response from the LLM endpoint.
     * Since getObject now uses streamObject internally, this is a streaming response.
     *
     * @param value - The object to return from the LLM.
     * @param options - Optional mock options.
     */
    mockGetObject: (value: Record<string, unknown>, options?: MockOptions) => {
      this.addBackendRoute('/ai/llm', value, { ...options, isStreaming: true });
    },
    /**
     * Mocks a streaming object response from the LLM endpoint.
     * Returns the object via SSE format with data: prefix.
     *
     * @param value - The object to stream from the LLM.
     * @param options - Optional mock options.
     */
    mockGetStreamedObject: (value: Record<string, unknown>, options?: MockOptions) => {
      this.addBackendRoute('/ai/llm', value, { ...options, isStreaming: true });
    },
  };

  /**
   * Helpers for tracking browser audio playback in tests.
   *
   * This is useful for components like the AudioPlayer in @rimori/react-client which:
   *  1) Fetch audio data from the backend (mocked via `env.ai.mockGetVoice`)
   *  2) Create `new Audio(url)` and call `.play()`
   *
   * With tracking enabled you can assert how many times audio playback was attempted:
   *
   * ```ts
   * await env.audio.enableTracking();
   * await env.ai.mockGetVoice(Buffer.from('dummy'), { method: 'POST' });
   * await env.setup();
   * // ...navigate and trigger audio...
   * const counts = await env.audio.getPlayCounts();
   * expect(counts.mediaPlayCalls).toBeGreaterThan(0);
   * ```
   *
   * **Counter Types:**
   * - `mediaPlayCalls`: Tracks calls to `.play()` on any `HTMLMediaElement` instance
   *   (including `<audio>`, `<video>` elements, or any element that inherits from `HTMLMediaElement`).
   *   This counter increments whenever `HTMLMediaElement.prototype.play()` is invoked.
   * - `audioPlayCalls`: Tracks calls to `.play()` specifically on instances created via the `Audio` constructor
   *   (e.g., `new Audio(url).play()`). This is a subset of `mediaPlayCalls` but provides more specific
   *   tracking for programmatically created audio elements.
   *
   * **Note**: Since `Audio` instances are also `HTMLMediaElement` instances, calling `.play()` on an
   * `Audio` object will increment **both** counters. For most use cases, checking `mediaPlayCalls`
   * is sufficient as it captures all audio playback attempts.
   */
  public readonly audio = {
    /**
     * Injects tracking hooks for HTMLMediaElement.play and the Audio constructor.
     * Must be called before the plugin code runs (ideally before env.setup()).
     */
    enableTracking: async (): Promise<void> => {
      await this.page.addInitScript(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        if (!w.__rimoriAudio) {
          w.__rimoriAudio = {
            mediaPlayCalls: 0,
            audioPlayCalls: 0,
          };
        }

        const proto = (w.HTMLMediaElement && w.HTMLMediaElement.prototype) || undefined;
        if (proto && !proto.__rimoriPatched) {
          const originalPlay = proto.play;
          proto.play = function (...args: unknown[]) {
            w.__rimoriAudio.mediaPlayCalls += 1;
            return originalPlay.apply(this, args as any);
          };
          Object.defineProperty(proto, '__rimoriPatched', {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false,
          });
        }

        const OriginalAudio = w.Audio;
        if (OriginalAudio && !OriginalAudio.__rimoriPatched) {
          const PatchedAudio = function (...args: any[]) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const audio: any = new (OriginalAudio as any)(...args);
            const originalPlay = audio.play.bind(audio);
            audio.play = () => {
              w.__rimoriAudio.audioPlayCalls += 1;
              return originalPlay();
            };
            return audio;
          };
          PatchedAudio.prototype = OriginalAudio.prototype;
          Object.defineProperty(PatchedAudio, '__rimoriPatched', {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false,
          });
          w.Audio = PatchedAudio;
        }
      });
    },

    /**
     * Returns current audio play counters from the browser context.
     *
     * @returns An object with two counters:
     *   - `mediaPlayCalls`: Total number of `.play()` calls on any `HTMLMediaElement` (includes all audio/video elements)
     *   - `audioPlayCalls`: Number of `.play()` calls on instances created via `new Audio()` (subset of `mediaPlayCalls`)
     *
     * **Note**: Since `Audio` extends `HTMLMediaElement`, calling `.play()` on an `Audio` instance increments both counters.
     * For general audio playback tracking, use `mediaPlayCalls` as it captures all playback attempts.
     */
    getPlayCounts: async (): Promise<{ mediaPlayCalls: number; audioPlayCalls: number }> => {
      return this.page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        if (!w.__rimoriAudio) {
          return { mediaPlayCalls: 0, audioPlayCalls: 0 };
        }
        return {
          mediaPlayCalls: Number(w.__rimoriAudio.mediaPlayCalls || 0),
          audioPlayCalls: Number(w.__rimoriAudio.audioPlayCalls || 0),
        };
      });
    },

    /**
     * Resets the audio play counters to zero.
     */
    resetPlayCounts: async (): Promise<void> => {
      await this.page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = window as any;
        if (w.__rimoriAudio) {
          w.__rimoriAudio.mediaPlayCalls = 0;
          w.__rimoriAudio.audioPlayCalls = 0;
        }
      });
    },
  };

  public readonly runtime = {
    mockFetchBackend: () => {},
  };

  public readonly sharedContent = {
    /**
     * Mock the /shared-content/generate backend endpoint.
     * Used by SharedContentController.getNew() to generate new content with AI.
     * @param value - The generated content to return
     * @param options - Optional mock options
     */
    mockGenerate: <T>(
      value: T & {
        id?: string;
        created_at?: string;
        created_by?: string;
        lang_id?: string;
        guild_id?: string;
        title?: string;
        keywords?: string[];
        verified?: boolean;
        skill_level?: LanguageLevel;
      },
      options?: MockOptions,
    ) => {
      const basicValues = {
        id: '6284adca-3e74-4634-8ea6-85ff867bb5e5',
        created_at: '2026-01-12T14:48:44.136Z',
        created_by: 'd9f231f4-a942-4bb6-bc41-1db185969b74',
        lang_id: 'sv',
        guild_id: '54235057-f0d8-45cf-99aa-787b10de3eba',
        title: 'Mitt husdjur',
        keywords: ['husdjur', 'katt', 'hund', 'fågel', 'namn', 'färg', 'ljud', 'äta', 'gammal', 'säg'],
        verified: true,
        skill_level: 'Pre-A1',
      };
      this.addBackendRoute('/shared-content/generate', { ...basicValues, ...value }, { ...options, method: 'POST' });
    },
    /**
     * Mock embedding generation endpoint for RAG search.
     * Used by SharedContentController.searchByTopic() to generate query embedding.
     * @param value - Object with embedding array: { embedding: number[] }
     * @param options - Optional mock options
     */
    mockEmbedding: (value: { embedding: number[] }, options?: MockOptions) => {
      this.addBackendRoute('/ai/embedding', value, { ...options, method: 'POST' });
    },
    /**
     * Mock RPC call for vector similarity search.
     * Used by SharedContentController.searchByTopic() for RAG-based content search.
     * @param value - Array of search results
     * @param options - Optional mock options
     */
    mockSearchByTopic: (value: unknown, options?: MockOptions) => {
      this.addSupabaseRoute('rpc/search_shared_content', value, { ...options, method: 'POST' });
    },
    /**
     * Mock fetching bookmarked shared content.
     * Used by SharedContentController.getBookmarked().
     * Note: The actual query uses a join with the completion table, so the response should include
     * the completed relation structure.
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     *                    The full table name `${pluginId}_sc_${tableName}` is automatically added
     * @param value - Array of content items with completed relation
     * @param options - Optional mock options
     */
    mockGetBookmarked: (tableName: string, value: unknown, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'GET' });
    },
    /**
     * Mock fetching ongoing shared content.
     * Used by SharedContentController.getOngoing().
     * Note: The actual query uses a join with the completion table.
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Array of content items with completed relation
     * @param options - Optional mock options
     */
    mockGetOngoing: (tableName: string, value: unknown, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'GET' });
    },
    /**
     * Mock fetching completed shared content.
     * Used by SharedContentController.getCompleted().
     * Note: The actual query uses a join with the completion table.
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Array of content items with completed relation
     * @param options - Optional mock options
     */
    mockGetCompleted: (tableName: string, value: unknown, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'GET' });
    },
    /**
     * Mock getting a specific shared content item by ID.
     * Used by SharedContentController.get().
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Single content item (not an array)
     * @param options - Optional mock options
     */
    mockGet: (tableName: string, value: unknown, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'GET' });
    },
    /**
     * Mock creating new shared content manually.
     * Used by SharedContentController.create().
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Created content item (single object, not array)
     * @param options - Optional mock options
     */
    mockCreate: (tableName: string, value: unknown, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'POST' });
    },
    /**
     * Mock updating shared content.
     * Used by SharedContentController.update().
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Updated content item (single object, not array)
     * @param options - Optional mock options
     */
    mockUpdate: (tableName: string, value: unknown, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'PATCH' });
    },
    /**
     * Mock completing shared content (marks as completed in completion table).
     * Used by SharedContentController.complete().
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     *                    The completion table name `${pluginId}_sc_${tableName}_completed` is automatically added
     * @param value - Optional response value (defaults to empty object for upsert)
     * @param options - Optional mock options
     */
    mockComplete: (tableName: string, value: unknown = {}, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}_completed`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'POST' });
    },
    /**
     * Mock updating shared content state (ongoing/hidden/completed).
     * Used by SharedContentController.updateState().
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Optional response value (defaults to empty object for upsert)
     * @param options - Optional mock options
     */
    mockUpdateState: (tableName: string, value: unknown = {}, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}_completed`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'POST' });
    },
    /**
     * Mock bookmarking shared content.
     * Used by SharedContentController.bookmark().
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Optional response value (defaults to empty object for upsert)
     * @param options - Optional mock options
     */
    mockBookmark: (tableName: string, value: unknown = {}, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}_completed`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'POST' });
    },
    /**
     * Mock reacting to shared content (like/dislike).
     * Used by SharedContentController.react().
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Optional response value (defaults to empty object for upsert)
     * @param options - Optional mock options
     */
    mockReact: (tableName: string, value: unknown = {}, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}_completed`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'POST' });
    },
    /**
     * Mock removing shared content (DELETE).
     * Used by SharedContentController.remove().
     * @param tableName - Table name WITHOUT plugin prefix (e.g., 'grammar_exercises')
     * @param value - Optional response value (DELETE typically returns empty)
     * @param options - Optional mock options
     */
    mockRemove: (tableName: string, value: unknown, options?: MockOptions) => {
      const fullTableName = `${this.pluginId}_sc_${tableName}`;
      this.addSupabaseRoute(fullTableName, value, { ...options, method: 'DELETE' });
    },
  };
  public readonly exercise = {
    mockView: () => {},
    mockAdd: () => {},
    mockDelete: () => {},
  };

  public readonly navigation = {
    mockToDashboard: () => {},
  };
}
