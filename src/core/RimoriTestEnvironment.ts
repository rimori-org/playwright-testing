import { Page, Route, Request } from '@playwright/test';
import { RimoriInfo } from '@rimori/client/dist/plugin/CommunicationHandler';
import { UserInfo } from '@rimori/client/dist/controller/SettingsController';
import { MainPanelAction, Plugin } from '@rimori/client/dist/fromRimori/PluginTypes';
import { DEFAULT_USER_INFO } from '../fixtures/default-user-info';
import { MessageChannelSimulator } from './MessageChannelSimulator';

interface RimoriTestEnvironmentOptions {
  page: Page;
  pluginId: string;
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
}

interface MockRecord {
  value: unknown;
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

  public constructor(options: RimoriTestEnvironmentOptions) {
    this.page = options.page;
    this.pluginId = options.pluginId;
    // TODO move to a function
    this.rimoriInfo = {
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
    };
    this.interceptRoutes();
  }

  private interceptRoutes(): void {
    this.page.route(`${this.rimoriInfo.backendUrl}/**`, (route: Route) => this.handleRoute(route, this.backendRoutes));
    this.page.route(`${this.rimoriInfo.url}/**`, (route: Route) => this.handleRoute(route, this.supabaseRoutes));
  }

  public async setup(): Promise<void> {
    console.log('Setting up RimoriTestEnvironment');

    // Add default handlers for common routes that plugins typically access
    // These can be overridden by explicit mock calls
    if (!this.supabaseRoutes[this.createRouteKey('GET', `${this.rimoriInfo.url}/rest/v1/plugin_settings`)]) {
      // Default: no settings exist (null) - triggers INSERT flow
      // Can be overridden with mockGetSettings() to return existing settings
      this.plugin.mockGetSettings(null);
    }

    if (!this.supabaseRoutes[this.createRouteKey('PATCH', `${this.rimoriInfo.url}/rest/v1/plugin_settings`)]) {
      // Default PATCH handler for plugin_settings - returns empty array (no rows updated)
      // This triggers INSERT (POST) flow
      // Can be overridden with mockSetSettings() to simulate successful update
      this.plugin.mockSetSettings([]);
    }

    if (!this.supabaseRoutes[this.createRouteKey('POST', `${this.rimoriInfo.url}/rest/v1/plugin_settings`)]) {
      // Default POST handler for plugin_settings - simulates successful insert
      // Can be overridden with mockInsertSettings() to customize response
      this.plugin.mockInsertSettings();
    }

    // Initialize MessageChannelSimulator to simulate parent-iframe communication
    // This makes the plugin think it's running in an iframe (not standalone mode)
    // Convert RimoriInfo from CommunicationHandler format to MessageChannelSimulator format
    this.messageChannelSimulator = new MessageChannelSimulator({
      page: this.page,
      pluginId: this.pluginId,
      queryParams: {},
      rimoriInfo: {
        ...this.rimoriInfo,
        guild: {
          id: this.rimoriInfo.guild.id,
          longTermGoalOverride:
            'longTermGoalOverride' in this.rimoriInfo.guild ? (this.rimoriInfo.guild as any).longTermGoalOverride : '',
          allowUserPluginSettings: this.rimoriInfo.guild.allowUserPluginSettings,
        },
        installedPlugins: this.rimoriInfo.installedPlugins.map((p) => ({
          id: p.id,
          title: p.info?.title || '',
          description: p.info?.description || '',
          logo: p.info?.logo || '',
          url: p.pages?.external_hosted_url || '',
        })),
        mainPanelPlugin: this.rimoriInfo.mainPanelPlugin
          ? {
              id: this.rimoriInfo.mainPanelPlugin.id,
              title: this.rimoriInfo.mainPanelPlugin.info?.title || '',
              description: this.rimoriInfo.mainPanelPlugin.info?.description || '',
              logo: this.rimoriInfo.mainPanelPlugin.info?.logo || '',
              url: this.rimoriInfo.mainPanelPlugin.pages?.external_hosted_url || '',
            }
          : undefined,
        sidePanelPlugin: this.rimoriInfo.sidePanelPlugin
          ? {
              id: this.rimoriInfo.sidePanelPlugin.id,
              title: this.rimoriInfo.sidePanelPlugin.info?.title || '',
              description: this.rimoriInfo.sidePanelPlugin.info?.description || '',
              logo: this.rimoriInfo.sidePanelPlugin.info?.logo || '',
              url: this.rimoriInfo.sidePanelPlugin.pages?.external_hosted_url || '',
            }
          : undefined,
      },
    });

    // Initialize the simulator - this injects the necessary shims
    // to intercept window.parent.postMessage calls and set up MessageChannel communication
    await this.messageChannelSimulator.initialize();
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

  private async handleRoute(route: Route, routes: Record<string, MockRecord[]>): Promise<void> {
    console.warn('handleRoute is not tested');
    const request = route.request();
    const requestUrl = request.url();
    const method = request.method().toUpperCase() as HttpMethod;
    const routeKey = this.createRouteKey(method, requestUrl);
    console.log('Handling route', routeKey);

    const mocks = routes[routeKey];
    if (!mocks || mocks.length === 0) {
      console.error('No route handler found for route', routeKey);
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

    if (options?.error) {
      return await route.abort(options.error);
    }

    // Handle streaming responses (for mockGetSteamedText)
    // Since Playwright requires complete body, we format as SSE without delays
    if (matchingMock.isStreaming && typeof matchingMock.value === 'string') {
      const body = this.formatAsSSE(matchingMock.value);

      return await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body,
      });
    }

    // Regular JSON response
    route.fulfill({
      status: 200,
      body: JSON.stringify(matchingMock.value),
    });
  }

  /**
   * Adds a supabase route to the supabase routes object.
   * @param path - The path of the route.
   * @param values - The values to return in the response.
   * @param options - The options for the route. Method defaults to 'GET' if not specified.
   */
  private addSupabaseRoute(path: string, values: unknown, options?: MockOptions): void {
    console.warn('addSupabaseRoute is not tested');
    const method = options?.method ?? 'GET';
    const fullPath = `${this.rimoriInfo.url}/rest/v1/${path}`;
    const routeKey = this.createRouteKey(method, fullPath);
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
    console.warn('addBackendRoute is not tested');
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
     * Mocks PATCH request for updating plugin_settings.
     * @param response - The response for PATCH. Defaults to empty array (no rows updated).
     *                   Should return array with updated row(s) like [{ id: '...' }] if update succeeds.
     */
    mockSetSettings: (response?: unknown, options?: MockOptions) => {
      console.log('Mocking set settings for mockSetSettings', response, options);
      console.warn('mockSetSettings is not tested');

      // PATCH request returns array of updated rows
      // Empty array means no rows matched (will trigger INSERT)
      // Array with items means update succeeded
      const defaultResponse = response ?? [];
      this.addSupabaseRoute('plugin_settings', defaultResponse, { ...options, method: 'PATCH' });
    },
    /**
     * Mocks GET request for fetching plugin_settings.
     * @param settingsRow - The full row object from plugin_settings table, or null if not found.
     *                      Should include: { id, plugin_id, guild_id, settings, is_guild_setting, user_id }.
     *                      If null, simulates no settings exist (triggers INSERT flow).
     */
    mockGetSettings: (
      settingsRow: {
        id?: string;
        plugin_id?: string;
        guild_id?: string;
        settings?: Record<string, unknown>;
        is_guild_setting?: boolean;
        user_id?: string | null;
      } | null,
      options?: MockOptions,
    ) => {
      console.log('Mocking get settings for mockGetSettings', settingsRow, options);
      console.warn('mockGetSettings is not tested');

      // GET request returns the full row or null (from maybeSingle())
      // null means no settings exist, which triggers setSettings() -> INSERT
      this.addSupabaseRoute('plugin_settings', settingsRow, options);
    },
    /**
     * Mocks POST request for inserting plugin_settings.
     * @param response - The response for POST. Defaults to success response with inserted row.
     */
    mockInsertSettings: (response?: unknown, options?: MockOptions) => {
      console.log('Mocking insert settings for mockInsertSettings', response, options);
      console.warn('mockInsertSettings is not tested');

      // POST request returns the inserted row or success response
      // Default to an object representing successful insert
      const defaultResponse = response ?? {
        id: 'mock-settings-id',
        plugin_id: this.pluginId,
        guild_id: this.rimoriInfo.guild.id,
      };
      this.addSupabaseRoute('plugin_settings', defaultResponse, { ...options, method: 'POST' });
    },
    mockGetUserInfo: (userInfo: Partial<UserInfo>, options?: MockOptions) => {
      console.log('Mocking get user info for mockGetUserInfo', userInfo, options);
      console.warn('mockGetUserInfo is not tested');
      this.addSupabaseRoute('/user-info', { ...this.rimoriInfo.profile, ...userInfo }, { ...options, delay: 0 });
    },
    mockGetPluginInfo: (pluginInfo: Plugin, options?: MockOptions) => {
      console.log('Mocking get plugin info for mockGetPluginInfo', pluginInfo, options);
      console.warn('mockGetPluginInfo is not tested');
      this.addSupabaseRoute('/plugin-info', pluginInfo, options);
    },
  };

  public readonly db = {
    mockFrom: () => {},
    mockTable: () => {},
  };

  public readonly event = {
    mockEmit: () => {},
    mockRequest: () => {},
    mockOn: () => {},
    mockOnce: () => {},
    mockRespond: () => {},
    mockEmitAccomplishment: () => {},
    mockOnAccomplishment: () => {},
    mockEmitSidebarAction: () => {},
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
      console.log('[RimoriTestEnvironment] Setting up listener for topic:', topic, 'with payload:', payload);

      const actionPayload = payload;
      const off = this.messageChannelSimulator.on(topic, async (event) => {
        console.log('[RimoriTestEnvironment] Received action.requestSidebar event:', event);
        console.log('[RimoriTestEnvironment] Responding to action.requestSidebar with payload:', actionPayload);
        await this.messageChannelSimulator!.emit(topic, actionPayload, 'sidebar');
        off();
      });

      console.log('[RimoriTestEnvironment] Listener set up for topic:', topic);
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
      console.log('[RimoriTestEnvironment] Setting up listener for topic:', topic, 'with payload:', payload);

      // Store the payload in a closure so we can respond with it
      const actionPayload = payload;

      // Set up a one-time listener that responds when the plugin emits 'action.requestMain'
      // The handler receives the event object from the plugin
      const off = this.messageChannelSimulator.on(topic, async (event) => {
        console.log('[RimoriTestEnvironment] Received action.requestMain event:', event);
        console.log('[RimoriTestEnvironment] Responding to action.requestMain with payload:', actionPayload);
        // When plugin emits 'action.requestMain', respond with the MainPanelAction data
        // The sender is 'mainPanel' to match rimori-main's MainPluginHandler behavior
        await this.messageChannelSimulator!.emit(topic, actionPayload, 'mainPanel');
        off(); // Remove listener after responding once (one-time response like EventBus.respond)
      });

      console.log('[RimoriTestEnvironment] Listener set up for topic:', topic);
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
      console.log('Mocking get steamed text for mockGetSteamedText', text, options);
      console.warn('mockGetSteamedText is not tested');

      this.addBackendRoute('/ai/llm', text, { ...options, isStreaming: true });
    },
    mockGetVoice: (values: Buffer, options?: MockOptions) => {
      console.log('Mocking get voice for mockGetVoice', values, options);
      console.warn('mockGetVoice is not tested');
      this.addBackendRoute('/voice/tts', values, options);
    },
    mockGetTextFromVoice: (text: string, options?: MockOptions) => {
      console.log('Mocking get text from voice for mockGetTextFromVoice', text, options);
      console.warn('mockGetTextFromVoice is not tested');
      this.addBackendRoute('/voice/stt', text, options);
    },
    mockGetObject: (value: unknown, options?: MockOptions) => {
      console.log('Mocking get object for mockGetObject', value, options);
      console.warn('mockGetObject is not tested');
      this.addBackendRoute('/ai/llm-object', value, { ...options, method: 'POST' });
    },
  };

  public readonly runtime = {
    mockFetchBackend: () => {},
  };

  public readonly community = {
    sharedContent: {
      mockGet: () => {},
      mockGetList: () => {},
      mockGetNew: () => {},
      mockCreate: () => {},
      mockUpdate: () => {},
      mockComplete: () => {},
      mockUpdateState: () => {},
      mockRemove: () => {},
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
// TODO: The matcher option of RimoriTestEnvironment v1 might be useful to use
