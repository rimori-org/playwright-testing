import { Page, Route, Request, ConsoleMessage } from '@playwright/test';
import { RimoriInfo } from '@rimori/client/dist/plugin/CommunicationHandler';
import { UserInfo } from '@rimori/client/dist/controller/SettingsController';
import { MainPanelAction, Plugin } from '@rimori/client/dist/fromRimori/PluginTypes';
import { DEFAULT_USER_INFO } from '../fixtures/default-user-info';
import { MessageChannelSimulator } from './MessageChannelSimulator';
import { SettingsStateManager, PluginSettings } from './SettingsStateManager';
import { EventPayload } from '@rimori/client/dist/fromRimori/EventBus';

interface RimoriTestEnvironmentOptions {
  page: Page;
  pluginId: string;
  pluginUrl: string;
  settings?: PluginSettings;
  queryParams?: Record<string, string>;
  userInfo?: Record<string, unknown>;
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
    this.messageChannelSimulator.on('global.accomplishment.triggerMicro', () => {
      // No-op handler - does nothing
    });
    this.messageChannelSimulator.on('global.accomplishment.triggerMacro', () => {
      // No-op handler - does nothing
    });
  }

  private getRimoriInfo(options: RimoriTestEnvironmentOptions): RimoriInfo {
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
      profile: DEFAULT_USER_INFO,
      mainPanelPlugin: undefined,
      sidePanelPlugin: undefined,
      interfaceLanguage: DEFAULT_USER_INFO.mother_tongue.code, // Set interface language from user's mother tongue
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
   * Sets up default handlers for shared_content and shared_content_completed routes.
   * These provide sensible defaults so tests don't need to mock every shared content call.
   */
  private setupSharedContentRoutes(): void {
    // GET: Return empty array for getCompletedTopics and getSharedContentList
    this.addSupabaseRoute('shared_content', [], { method: 'GET' });

    // POST: Return created content with generated ID for createSharedContent
    this.addSupabaseRoute(
      'shared_content',
      async (request: Request) => {
        try {
          const postData = request.postData();
          if (postData) {
            const content = JSON.parse(postData);
            // Return the content with a generated ID
            return [
              {
                id: `shared-content-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                ...content,
                created_at: new Date().toISOString(),
              },
            ];
          }
          return [];
        } catch {
          return [];
        }
      },
      { method: 'POST' }
    );

    // PATCH: Return updated content for updateSharedContent and removeSharedContent
    this.addSupabaseRoute(
      'shared_content',
      async (request: Request) => {
        try {
          const postData = request.postData();
          if (postData) {
            const updates = JSON.parse(postData);
            return [{ id: 'updated-content', ...updates }];
          }
          return [];
        } catch {
          return [];
        }
      },
      { method: 'PATCH' }
    );

    // POST: Handle shared_content_completed upserts
    this.addSupabaseRoute('shared_content_completed', {}, { method: 'POST' });
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

    // Find the first matching mock based on matcher function
    // Priority: mocks with matchers that match > mocks without matchers (as fallback)
    let matchingMock: MockRecord | undefined;
    let fallbackMock: MockRecord | undefined;

    for (const mock of mocks) {
      if (mock.options?.matcher) {
        try {
          if (mock.options.matcher(request)) {
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

    // Handle streaming responses (for mockGetSteamedText)
    // Since Playwright requires complete body, we format as SSE without delays
    if (matchingMock.isStreaming && typeof responseValue === 'string') {
      const body = this.formatAsSSE(responseValue);

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
      this.addSupabaseRoute('/user-info', { ...this.rimoriInfo.profile, ...userInfo }, { ...options, delay: 0 });
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
     * Registers a one-time auto-responder for request/response style events.
     *
     * When the plugin calls `plugin.event.request(topic, data)`, this registered responder
     * will automatically return the provided response value. The responder is automatically
     * removed after the first request, ensuring it only responds once.
     *
     * Example:
     * ```ts
     * // Register a responder that will return deck summaries when requested
     * env.event.mockRequest('deck.requestOpenToday', [
     *   { id: 'deck-1', name: 'My Deck', total_new: 5, total_learning: 2, total_review: 10 }
     * ]);
     *
     * // Now when the plugin calls: plugin.event.request('deck.requestOpenToday', {})
     * // It will receive the deck summaries array above
     * ```
     *
     * @param topic - The event topic to respond to (e.g., 'deck.requestOpenToday')
     * @param response - The response value to return, or a function that receives the event and returns the response
     * @returns A function to manually remove the responder before it's used
     */
    mockRequest: (topic: string, response: unknown | ((event: unknown) => unknown)) => {
      if (!this.messageChannelSimulator) {
        throw new Error('MessageChannelSimulator not initialized. Call setup() first.');
      }
      return this.messageChannelSimulator.respondOnce(topic, response);
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

      // Set up a one-time listener that responds when the plugin emits 'action.requestMain'
      // The handler receives the event object from the plugin
      const off = this.messageChannelSimulator.on(topic, async (event) => {
        // When plugin emits 'action.requestMain', respond with the MainPanelAction data
        // The sender is 'mainPanel' to match rimori-main's MainPluginHandler behavior
        await this.messageChannelSimulator!.emit(topic, actionPayload, 'mainPanel');
        off(); // Remove listener after responding once (one-time response like EventBus.respond)
      });
    },
  };

  public readonly ai = {
    mockGetText: (values: unknown, options?: MockOptions) => {
      console.log('Mocking get text for mockGetText', values, options);
      console.warn('mockGetText is not tested');
      this.addBackendRoute('/llm-text', values, options);
    },
    /**
     * Mocks a streaming text response from the LLM endpoint.
     * The text will be formatted as SSE (Server-Sent Events) to simulate streaming.
     *
     * **Note**: Due to Playwright's route.fulfill() requiring a complete response body,
     * all SSE chunks are sent at once (no delays). The client will still parse it as SSE correctly.
     *
     * @param text - The text to stream. Will be formatted as SSE chunks.
     * @param options - Optional mock options.
     */
    mockGetSteamedText: (text: string, options?: MockOptions) => {
      this.addBackendRoute('/ai/llm', text, { ...options, isStreaming: true });
    },
    mockGetVoice: (values: Buffer, options?: MockOptions) => {
      this.addBackendRoute('/voice/tts', values, options);
    },
    mockGetTextFromVoice: (text: string, options?: MockOptions) => {
      this.addBackendRoute('/voice/stt', text, options);
    },
    mockGetObject: (value: unknown, options?: MockOptions) => {
      this.addBackendRoute('/ai/llm-object', value, { ...options, method: 'POST' });
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

  public readonly community = {
    sharedContent: {
      /**
       * Mock the shared_content GET endpoint for fetching a single item.
       * Used by SharedContentController.getSharedContent()
       */
      mockGet: (value: unknown, options?: MockOptions) => {
        this.addSupabaseRoute('shared_content', value, { ...options, method: 'GET' });
      },
      /**
       * Mock the shared_content GET endpoint for fetching multiple items.
       * Used by SharedContentController.getSharedContentList() and getCompletedTopics()
       */
      mockGetList: (value: unknown[], options?: MockOptions) => {
        this.addSupabaseRoute('shared_content', value, { ...options, method: 'GET' });
      },
      /**
       * Mock the shared_content POST endpoint for creating new content.
       * Used by SharedContentController.createSharedContent() after AI generation.
       * Note: getNewSharedContent() first calls ai.getObject() (mock via env.ai.mockGetObject),
       * then calls createSharedContent() which hits this endpoint.
       */
      mockCreate: (value: unknown, options?: MockOptions) => {
        this.addSupabaseRoute('shared_content', value, { ...options, method: 'POST' });
      },
      /**
       * Mock the shared_content PATCH endpoint for updating content.
       * Used by SharedContentController.updateSharedContent() and removeSharedContent() (soft delete)
       */
      mockUpdate: (value: unknown, options?: MockOptions) => {
        this.addSupabaseRoute('shared_content', value, { ...options, method: 'PATCH' });
      },
      /**
       * Mock the shared_content_completed POST endpoint (upsert).
       * Used by SharedContentController.completeSharedContent() and updateSharedContentState()
       */
      mockComplete: (value: unknown = {}, options?: MockOptions) => {
        this.addSupabaseRoute('shared_content_completed', value, { ...options, method: 'POST' });
      },
      /**
       * Mock the shared_content_completed POST endpoint for state updates.
       * Alias for mockComplete since both use upsert via POST.
       */
      mockUpdateState: (value: unknown = {}, options?: MockOptions) => {
        this.addSupabaseRoute('shared_content_completed', value, { ...options, method: 'POST' });
      },
      /**
       * Mock removing shared content (soft delete via PATCH).
       * Alias for mockUpdate since removeSharedContent uses PATCH to set deleted_at.
       */
      mockRemove: (value: unknown, options?: MockOptions) => {
        this.addSupabaseRoute('shared_content', value, { ...options, method: 'PATCH' });
      },
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

  // public readonly rimoriMain = {
  //   mockMainPanelTriggerAction: () => {},
  //   triggerMainPanelAction: async (data: MainPanelAction) => {
  //     await this.messageChannel.emit('global.mainPanel.triggerAction', data, 'global.mainPanel');
  //   },
  //   mockMainPanelActivePageChanged: () => {},
  //   triggerMainPanelActivePageChanged: async (payload: { pluginId?: string; pageId?: string }) => {
  //     await this.messageChannel.emit(
  //       'global.mainPanel.triggerActivePageChanged',
  //       { pluginId: payload.pluginId ?? this.pluginId, pageId: payload.pageId },
  //       'global.mainPanel',
  //     );
  //   },
  //   mockSidebarTriggerAction: () => {},
  //   triggerSidebarAction: async (payload: { pluginId: string; actionKey: string; text?: string }) => {
  //     await this.messageChannel.emit('global.sidebar.triggerAction', payload, 'global.sidebar');
  //   },
  //   mockNavigationTriggerToDashboard: () => {},
  //   triggerNavigationToDashboard: async () => {
  //     await this.messageChannel.emit('global.navigation.triggerToDashboard', {}, 'global.navigation');
  //   },
  //   mockLoggingRequestPluginLogs: () => {},
  //   requestPluginLogs: async () => {
  //     await this.messageChannel.emit('global.logging.requestPluginLogs', {}, 'global.logging');
  //   },
  //   mockSessionTriggerUrlChange: () => {},
  //   triggerSessionUrlChange: async (url: string) => {
  //     await this.messageChannel.emit(`${this.pluginId}.session.triggerUrlChange`, { url }, this.pluginId);
  //   },
  // };
}

// Todo: How to test if the event was received by the parent?
