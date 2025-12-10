import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { DEFAULT_USER_INFO } from '../fixtures/default-user-info';
import { UserInfo, RimoriInfo, EventBusMessage, EventPayload } from '@rimori/client';

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
  rimoriInfo: RimoriInfo;
  queryParams?: Record<string, string>;
};

type EventListener = (event: EventBusMessage) => void | Promise<void>;

type AutoResponder = (event: EventBusMessage) => unknown | Promise<unknown>;

export class MessageChannelSimulator {
  private readonly page: Page;
  private readonly pluginId: string;
  private readonly queryParams: Record<string, string>;
  private readonly rimoriInfo: RimoriInfo;

  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly autoResponders = new Map<string, AutoResponder>();
  private readonly pendingOutbound: PluginMessage[] = [];

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
    this.rimoriInfo = this.cloneRimoriInfo(rimoriInfo);

    this.registerAutoResponders();
  }

  public get defaultUserInfo(): UserInfo {
    return this.cloneUserInfo(this.rimoriInfo.profile);
  }

  public get userInfo(): UserInfo {
    return this.cloneUserInfo(this.rimoriInfo.profile);
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
  public async emit(topic: string, data: EventPayload, sender = 'global'): Promise<void> {
    const message: PluginMessage = {
      event: {
        timestamp: new Date().toISOString(),
        eventId: Math.floor(Math.random() * 1000000),
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
   * Registers a persistent auto-responder for a request/response topic.
   * The responder will continue to respond to all requests with the given topic
   * until explicitly removed.
   *
   * @param topic - The event topic to respond to
   * @param responder - A function that returns the response data, or a value to return directly
   * @returns A function to manually remove the responder
   */
  public respond(topic: string, responder: AutoResponder | unknown): () => void {
    const wrappedResponder: AutoResponder = (event) => {
      // If responder is a function, call it with the event, otherwise return the value directly
      if (typeof responder === 'function') {
        return (responder as AutoResponder)(event);
      }
      return responder;
    };

    this.autoResponders.set(topic, wrappedResponder);

    // Return a function to manually remove the responder
    return () => {
      this.autoResponders.delete(topic);
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
   * Overrides the user info.
   */
  public setUserInfo(userInfo: UserInfo): void {
    this.rimoriInfo.profile = userInfo;
  }

  public getRimoriInfo(): RimoriInfo {
    return this.cloneRimoriInfo(this.rimoriInfo);
  }

  private async setupMessageChannel(): Promise<void> {
    if (this.isReady) {
      return;
    }

    await this.page.evaluate(
      ({
        pluginId,
        queryParams,
        instanceId,
        rimoriInfo,
      }: {
        pluginId: string;
        queryParams: Record<string, string>;
        instanceId: string;
        rimoriInfo: RimoriInfo;
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
            rimoriInfo,
          },
          ports: [channel.port2],
        });

        window.dispatchEvent(initEvent);
      },
      {
        pluginId: this.pluginId,
        queryParams: this.queryParams,
        instanceId: this.instanceId,
        rimoriInfo: this.rimoriInfo,
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
      // Don't log an error if this is a request/response event with an auto-responder
      // (auto-responders handle request/response patterns, not listeners)
      const hasAutoResponder = event.eventId && this.autoResponders.has(event.topic);
      if (!hasAutoResponder) {
        console.log('[MessageChannelSimulator] No handlers found for topic:', event.topic);
        console.log('[MessageChannelSimulator] Available topics:', Array.from(this.listeners.keys()));
      }
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

  private cloneUserInfo(input: UserInfo | typeof DEFAULT_USER_INFO): UserInfo {
    return JSON.parse(JSON.stringify(input)) as UserInfo;
  }

  private registerAutoResponders(): void {
    this.autoResponders.set('global.supabase.requestAccess', () => this.cloneRimoriInfo(this.rimoriInfo));
    this.autoResponders.set('global.profile.requestUserInfo', () => this.cloneUserInfo(this.rimoriInfo.profile));
    this.autoResponders.set('global.profile.getUserInfo', () => this.cloneUserInfo(this.rimoriInfo.profile));
  }

  private cloneRimoriInfo(info: RimoriInfo): RimoriInfo {
    return JSON.parse(JSON.stringify(info)) as RimoriInfo;
  }
}
