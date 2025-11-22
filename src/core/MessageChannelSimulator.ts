import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { DEFAULT_USER_INFO } from '../fixtures/default-user-info';

type Language = {
  code: string;
  name: string;
  native: string;
  capitalized: string;
  uppercase: string;
};

type StudyBuddy = {
  id: string;
  name: string;
  description: string;
  avatarUrl: string;
  voiceId: string;
  aiPersonality: string;
};

export type UserInfo = {
  mother_tongue: Language;
  target_language: Language;
  skill_level_reading: string;
  skill_level_writing: string;
  skill_level_grammar: string;
  skill_level_speaking: string;
  skill_level_listening: string;
  skill_level_understanding: string;
  goal_longterm: string;
  goal_weekly: string;
  study_buddy: StudyBuddy;
  story_genre: string;
  study_duration: number;
  motivation_type: string;
  onboarding_completed: boolean;
  context_menu_on_select: boolean;
  user_name?: string;
  target_country: string;
  target_city?: string;
};

type RimoriGuild = {
  id: string;
  longTermGoalOverride: string;
  allowUserPluginSettings: boolean;
};

type PluginInfo = {
  id: string;
  title: string;
  description: string;
  logo: string;
  url: string;
};

type RimoriInfo = {
  url: string;
  key: string;
  backendUrl: string;
  token: string;
  expiration: Date;
  tablePrefix: string;
  pluginId: string;
  guild: RimoriGuild;
  installedPlugins: PluginInfo[];
  profile: UserInfo;
  mainPanelPlugin?: PluginInfo;
  sidePanelPlugin?: PluginInfo;
};

type SerializedRimoriInfo = {
  url: string;
  key: string;
  backendUrl: string;
  token: string;
  expiration: string;
  tablePrefix: string;
  pluginId: string;
  guild: RimoriGuild;
  installedPlugins: PluginInfo[];
  profile: UserInfo;
  mainPanelPlugin?: PluginInfo;
  sidePanelPlugin?: PluginInfo;
};

type EventBusMessage = {
  timestamp: string;
  sender: string;
  topic: string;
  data: unknown;
  debug: boolean;
  eventId?: number;
};

type PluginMessage =
  | {
      event: EventBusMessage;
      type?: undefined;
      eventId?: undefined;
      response?: undefined;
      error?: undefined;
    }
  | {
      type: 'response';
      eventId: number;
      response: {
        topic: string;
        data: unknown;
      };
      event?: undefined;
      error?: undefined;
    }
  | {
      type: 'error';
      eventId: number;
      error: unknown;
      event?: undefined;
      response?: undefined;
    };

type MessageChannelSimulatorArgs = {
  page: Page;
  pluginId: string;
  queryParams?: Record<string, string>;
  rimoriInfo?: RimoriInfo;
};

type EventListener = (event: EventBusMessage) => void | Promise<void>;

type AutoResponder = (event: EventBusMessage) => unknown | Promise<unknown>;

export class MessageChannelSimulator {
  private readonly page: Page;
  private readonly pluginId: string;
  private readonly queryParams: Record<string, string>;
  private readonly baseUserInfo: UserInfo;
  private readonly providedInfo?: RimoriInfo;

  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly autoResponders = new Map<string, AutoResponder>();
  private readonly pendingOutbound: PluginMessage[] = [];

  private currentUserInfo: UserInfo;
  private currentRimoriInfo: RimoriInfo | null = null;
  private isReady = false;
  private instanceId = randomUUID();

  /**
   * Creates a simulator that mimics the Rimori host for plugin tests.
   * @param param
   * @param param.page - Playwright page hosting the plugin iframe.
   * @param param.pluginId - Target plugin identifier.
   * @param param.queryParams - Query parameters forwarded to the plugin init.
   */
  public constructor({ page, pluginId, queryParams, rimoriInfo }: MessageChannelSimulatorArgs) {
    this.page = page;
    this.pluginId = pluginId;
    this.queryParams = queryParams ?? {};
    this.baseUserInfo = this.cloneUserInfo(DEFAULT_USER_INFO);
    this.currentUserInfo = this.cloneUserInfo(DEFAULT_USER_INFO);
    this.providedInfo = rimoriInfo ? this.cloneRimoriInfo(rimoriInfo) : undefined;

    this.registerAutoResponders();
  }

  public get defaultUserInfo(): UserInfo {
    return this.cloneUserInfo(this.baseUserInfo);
  }

  public get userInfo(): UserInfo {
    return this.cloneUserInfo(this.currentUserInfo);
  }

  /**
   * Injects the handshake shims so the plugin talks to this simulator.
   */
  public async initialize(): Promise<void> {
    await this.page.exposeBinding(
      '__rimoriSimulator_onHello',
      async () => {
        await this.setupMessageChannel();
      },
      { handle: false },
    );

    await this.page.exposeBinding(
      '__rimoriSimulator_onPortMessage',
      async (_source, payload: PluginMessage) => {
        await this.handlePortMessage(payload);
      },
      { handle: false },
    );

    await this.page.addInitScript(
      ({ pluginId }) => {
        // Create a fake parent window object to simulate iframe environment
        // This ensures window !== window.parent (so standalone mode is NOT triggered)
        const fakeParent = {
          postMessage: (
            message: unknown,
            targetOriginOrOptions?: string | WindowPostMessageOptions,
            transfer?: Transferable[],
          ) => {
            const payload = (message ?? {}) as {
              type?: string;
              pluginId?: string;
            };

            // Intercept rimori:hello messages
            if (payload.type === 'rimori:hello' && payload.pluginId === pluginId) {
              // @ts-expect-error binding injected at runtime
              window.__rimoriSimulator_onHello();
              return;
            }

            // Intercept rimori:acknowledged messages (plugin finished initialization)
            if (payload.type === 'rimori:acknowledged' && payload.pluginId === pluginId) {
              // Plugin has acknowledged init completion - no action needed, just intercept
              return;
            }

            // For all other messages, allow normal postMessage behavior
            // This handles cases where the plugin might send other messages
            // Handle both string targetOrigin and WindowPostMessageOptions object
            if (typeof targetOriginOrOptions === 'object' && targetOriginOrOptions !== null) {
              window.postMessage(message, targetOriginOrOptions);
            } else {
              window.postMessage(message, targetOriginOrOptions ?? '*', transfer);
            }
          },
          // Add other Window properties that might be accessed
          location: window.location,
          top: window.top,
          frames: window.frames,
          length: window.length,
          closed: false,
          opener: null,
          frameElement: null,
          self: window.self,
          window: window,
          document: window.document,
          navigator: window.navigator,
          history: window.history,
          screen: window.screen,
          outerHeight: window.outerHeight,
          outerWidth: window.outerWidth,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          pageXOffset: window.pageXOffset,
          pageYOffset: window.pageYOffset,
          // Make it NOT equal to window
          toString: () => '[object Window] (parent)',
        } as Window;

        // Override window.parent to return our fake parent
        // This makes window !== window.parent (iframe mode, not standalone)
        Object.defineProperty(window, 'parent', {
          get: () => fakeParent,
          configurable: true, // Allow reconfiguration if needed
          enumerable: true,
        });
      },
      {
        pluginId: this.pluginId,
      },
    );
  }

  /**
   * Sends an event into the plugin as though the Rimori parent emitted it.
   */
  public async emit(topic: string, data: unknown, sender = 'global'): Promise<void> {
    const message: PluginMessage = {
      event: {
        timestamp: new Date().toISOString(),
        sender,
        topic,
        data,
        debug: false,
      },
    };

    if (!this.isReady) {
      this.pendingOutbound.push(message);
      return;
    }

    await this.sendToPlugin(message);
  }

  /**
   * Registers a handler for events emitted from the plugin.
   */
  public on(topic: string, handler: EventListener): () => void {
    const handlers = this.listeners.get(topic) ?? new Set<EventListener>();
    handlers.add(handler);
    this.listeners.set(topic, handlers);

    return () => {
      const existing = this.listeners.get(topic);
      if (!existing) {
        return;
      }
      existing.delete(handler);
      if (existing.size === 0) {
        this.listeners.delete(topic);
      }
    };
  }

  /**
   * Registers a one-time auto-responder for a request/response topic.
   * When a request with an eventId comes in for this topic, the responder will
   * be called once and then automatically removed.
   *
   * @param topic - The event topic to respond to
   * @param responder - A function that returns the response data, or a value to return directly
   * @returns A function to manually remove the responder before it's used
   */
  public respondOnce(topic: string, responder: AutoResponder | unknown): () => void {
    let used = false;
    const wrappedResponder: AutoResponder = (event) => {
      if (used) {
        return undefined;
      }
      used = true;
      // Remove from autoResponders after first use
      this.autoResponders.delete(topic);

      // If responder is a function, call it with the event, otherwise return the value directly
      if (typeof responder === 'function') {
        return (responder as AutoResponder)(event);
      }
      return responder;
    };

    this.autoResponders.set(topic, wrappedResponder);

    // Return a function to manually remove the responder
    return () => {
      if (!used) {
        this.autoResponders.delete(topic);
        used = true;
      }
    };
  }

  /**
   * Overrides the default profile returned by the auto responders.
   */
  public setUserInfo(overrides: Partial<UserInfo>): void {
    this.currentUserInfo = this.mergeUserInfo(this.currentUserInfo, overrides);
    if (this.currentRimoriInfo) {
      this.currentRimoriInfo.profile = this.cloneUserInfo(this.currentUserInfo);
    }
  }

  public getRimoriInfo(): RimoriInfo | null {
    return this.currentRimoriInfo ? this.cloneRimoriInfo(this.currentRimoriInfo) : null;
  }

  private async setupMessageChannel(): Promise<void> {
    if (this.isReady) {
      return;
    }

    const rimoriInfo = this.buildRimoriInfo();
    this.currentRimoriInfo = rimoriInfo;
    const serialized = this.serializeRimoriInfo(rimoriInfo);

    await this.page.evaluate(
      ({
        pluginId,
        queryParams,
        instanceId,
        rimoriInfo: info,
      }: {
        pluginId: string;
        queryParams: Record<string, string>;
        instanceId: string;
        rimoriInfo: SerializedRimoriInfo;
      }) => {
        const channel = new MessageChannel();

        channel.port1.onmessage = (event) => {
          // @ts-expect-error binding injected via exposeBinding
          window.__rimoriSimulator_onPortMessage(event.data);
        };

        (
          window as unknown as {
            __rimoriSimulator_sendToPlugin: (payload: unknown) => void;
          }
        ).__rimoriSimulator_sendToPlugin = (payload: unknown) => {
          channel.port1.postMessage(payload);
        };

        const initEvent = new MessageEvent('message', {
          data: {
            type: 'rimori:init',
            pluginId,
            instanceId,
            queryParams,
            rimoriInfo: {
              ...info,
              expiration: new Date(info.expiration),
            },
          },
          ports: [channel.port2],
        });

        window.dispatchEvent(initEvent);
      },
      {
        pluginId: this.pluginId,
        queryParams: this.queryParams,
        instanceId: this.instanceId,
        rimoriInfo: serialized,
      },
    );

    this.isReady = true;
    await this.flushPending();
  }

  private async sendToPlugin(message: PluginMessage): Promise<void> {
    await this.page.evaluate((payload: PluginMessage) => {
      const bridge = (
        window as unknown as {
          __rimoriSimulator_sendToPlugin?: (value: PluginMessage) => void;
        }
      ).__rimoriSimulator_sendToPlugin;

      if (!bridge) {
        throw new Error('Simulator bridge unavailable');
      }

      bridge(payload);
    }, message);
  }

  private async flushPending(): Promise<void> {
    if (!this.pendingOutbound.length) {
      return;
    }

    for (const message of this.pendingOutbound.splice(0)) {
      await this.sendToPlugin(message);
    }
  }

  private async handlePortMessage(payload: PluginMessage): Promise<void> {
    if (!payload) {
      return;
    }

    if ('event' in payload && payload.event) {
      // console.log(
      //   '[MessageChannelSimulator] handlePortMessage - received event:',
      //   payload.event.topic,
      //   'from:',
      //   payload.event.sender,
      // );
      await this.dispatchEvent(payload.event);
      await this.maybeRespond(payload.event);
      return;
    }
  }

  private async dispatchEvent(event: EventBusMessage): Promise<void> {
    // console.log(
    //   '[MessageChannelSimulator] dispatchEvent - topic:',
    //   event.topic,
    //   'sender:',
    //   event.sender,
    //   'listeners:',
    //   this.listeners.has(event.topic) ? this.listeners.get(event.topic)?.size : 0,
    // );
    const handlers = this.listeners.get(event.topic);
    if (!handlers?.size) {
      console.log('[MessageChannelSimulator] No handlers found for topic:', event.topic);
      console.log('[MessageChannelSimulator] Available topics:', Array.from(this.listeners.keys()));
      return;
    }

    // console.log('[MessageChannelSimulator] Calling', handlers.size, 'handler(s) for topic:', event.topic);
    for (const handler of handlers) {
      await handler(event);
    }
  }

  private async maybeRespond(event: EventBusMessage): Promise<void> {
    if (!event.eventId) {
      return;
    }

    const responder = this.autoResponders.get(event.topic);
    if (!responder) {
      return;
    }

    const data = await responder(event);
    await this.sendToPlugin({
      type: 'response',
      eventId: event.eventId,
      response: {
        topic: event.topic,
        data,
      },
    });
  }

  private buildRimoriInfo(): RimoriInfo {
    if (this.providedInfo) {
      const clone = this.cloneRimoriInfo(this.providedInfo);
      clone.profile = this.cloneUserInfo(this.currentUserInfo);
      clone.pluginId = this.pluginId;
      clone.tablePrefix = clone.tablePrefix || `${this.pluginId}_`;
      return clone;
    }

    return {
      url: 'http://localhost:3500',
      key: 'rimori-sdk-key',
      backendUrl: 'http://localhost:3501',
      token: 'rimori-token',
      expiration: new Date(Date.now() + 60 * 60 * 1000),
      tablePrefix: `${this.pluginId}_`,
      pluginId: this.pluginId,
      guild: {
        id: 'guild-test',
        longTermGoalOverride: '',
        allowUserPluginSettings: true,
      },
      installedPlugins: [
        {
          id: this.pluginId,
          title: 'Test Plugin',
          description: 'Playwright testing plugin',
          logo: '',
          url: 'https://plugins.rimori.localhost',
        },
      ],
      profile: this.cloneUserInfo(this.currentUserInfo),
    };
  }

  private serializeRimoriInfo(info: RimoriInfo): SerializedRimoriInfo {
    return {
      ...info,
      expiration: info.expiration.toISOString(),
    };
  }

  private cloneUserInfo(input: UserInfo | typeof DEFAULT_USER_INFO): UserInfo {
    return JSON.parse(JSON.stringify(input)) as UserInfo;
  }

  private mergeUserInfo(current: UserInfo, overrides: Partial<UserInfo>): UserInfo {
    const clone = this.cloneUserInfo(current);

    if (overrides.mother_tongue) {
      clone.mother_tongue = {
        ...clone.mother_tongue,
        ...overrides.mother_tongue,
      };
    }

    if (overrides.target_language) {
      clone.target_language = {
        ...clone.target_language,
        ...overrides.target_language,
      };
    }

    if (overrides.study_buddy) {
      clone.study_buddy = {
        ...clone.study_buddy,
        ...overrides.study_buddy,
      };
    }

    const { mother_tongue, target_language, study_buddy, ...rest } = overrides;

    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) {
        continue;
      }
      (clone as Record<string, unknown>)[key] = value;
    }

    return clone;
  }

  private registerAutoResponders(): void {
    this.autoResponders.set('global.supabase.requestAccess', () => this.buildRimoriInfo());
    this.autoResponders.set('global.profile.requestUserInfo', () => this.cloneUserInfo(this.currentUserInfo));
    this.autoResponders.set('global.profile.getUserInfo', () => this.cloneUserInfo(this.currentUserInfo));
  }

  private cloneRimoriInfo(info: RimoriInfo): RimoriInfo {
    return {
      ...info,
      expiration: new Date(info.expiration),
      guild: { ...info.guild },
      installedPlugins: info.installedPlugins.map((plugin) => ({ ...plugin })),
      profile: this.cloneUserInfo(info.profile),
    };
  }
}
