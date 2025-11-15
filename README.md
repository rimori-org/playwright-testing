# @rimori/playwright

Playwright testing utilities for Rimori plugins. This package provides a complete testing environment that simulates how plugins run within the Rimori application, including MessageChannel communication, API mocking, and event handling.

## Overview

The `@rimori/playwright` package enables end-to-end testing of Rimori plugins by:

- **Simulating iframe environment**: Makes plugins think they're running in an iframe (not standalone mode)
- **MessageChannel simulation**: Mimics the parent-iframe communication used in production
- **API mocking**: Provides mock handlers for Supabase and backend endpoints
- **Event handling**: Simulates Rimori events like main panel actions and sidebar actions

## Installation

```bash
npm install --save-dev @rimori/playwright @playwright/test
# or
pnpm add -D @rimori/playwright @playwright/test
```

## Quick Start

```typescript
import { test, expect } from '@playwright/test';
import { RimoriTestEnvironment } from '@rimori/playwright';

const pluginId = 'pl7720512027';
const pluginUrl = 'http://localhost:3009';

test.describe('My Plugin', () => {
  let env: RimoriTestEnvironment;

  test.beforeEach(async ({ page }) => {
    env = new RimoriTestEnvironment({ page, pluginId });
    
    // Set up mocks
    env.ai.mockGetObject({ result: 'data' });
    
    // Initialize the test environment
    await env.setup();
    await page.goto(`${pluginUrl}/#/my-page`);
  });

  test('should work correctly', async ({ page }) => {
    await expect(page.getByText('Hello')).toBeVisible();
  });
});
```

## Core Concepts

### MessageChannel Simulation

Plugins communicate with the Rimori parent application via MessageChannel. The `RimoriTestEnvironment` automatically sets up a MessageChannel simulation. This ensures plugins run in iframe mode, not standalone mode, matching production behavior.

### Test Environment Setup

The test environment:

- Sets default handlers for common routes (plugin_settings, etc.)
- Initializes MessageChannel communication
- Provides default RimoriInfo with test credentials
- Routes requests to appropriate mock handlers

## API Reference

### RimoriTestEnvironment

Main test environment class that provides mocking capabilities and MessageChannel simulation.

#### Constructor

```typescript
new RimoriTestEnvironment({
  page: Page,
  pluginId: string,
  queryParams?: Record<string, string>,
  userInfo?: Record<string, unknown>,
  installedPlugins?: Plugin[],
  guildOverrides?: Record<string, unknown>
})
```

**Example:**
```typescript
const env = new RimoriTestEnvironment({
  page,
  pluginId: 'pl1234567890',
  queryParams: { applicationMode: 'sidebar' },
});
```

#### Methods

##### `setup(): Promise<void>`

Initializes the test environment. Must be called before navigating to the plugin page.

```typescript
await env.setup();
await page.goto(pluginUrl);
```

### AI Mocking (`env.ai`)

Mock AI/LLM backend endpoints.

#### `mockGetText(values: unknown, options?: MockOptions)`

Mocks a non-streaming text generation response.

```typescript
env.ai.mockGetText({ result: 'Generated text' });
```

#### `mockGetSteamedText(text: string, options?: MockOptions)`

Mocks a streaming text response formatted as SSE (Server-Sent Events).

**Note**: Due to Playwright's `route.fulfill()` limitations, all SSE chunks are sent at once (no visible delays). The client will still parse it correctly as SSE.

```typescript
env.ai.mockGetSteamedText('This is the streaming response text.');
```

#### `mockGetObject(value: unknown, options?: MockOptions)`

Mocks structured object generation (e.g., translation results).

```typescript
env.ai.mockGetObject(
  {
    type: 'noun',
    translation_swedish: 'träd',
    translation_mother_tongue: 'tree',
  },
  {
    matcher: (request) => {
      const body = request.postDataJSON();
      return body?.instructions?.includes('Look up the word') ?? false;
    },
  }
);
```

#### `mockGetVoice(values: Buffer, options?: MockOptions)`

Mocks text-to-speech voice generation.

#### `mockGetTextFromVoice(text: string, options?: MockOptions)`

Mocks speech-to-text transcription.

### Plugin Settings (`env.plugin`)

Mock plugin settings endpoints.

#### `mockGetSettings(settingsRow, options?)`

Mocks GET request for plugin settings.

```typescript
// Return existing settings
env.plugin.mockGetSettings({
  id: 'settings-id',
  plugin_id: pluginId,
  guild_id: 'guild-id',
  settings: { theme: 'dark' },
  is_guild_setting: false,
});

// Return null to simulate no settings (triggers INSERT flow)
env.plugin.mockGetSettings(null);
```

#### `mockSetSettings(response?, options?)`

Mocks PATCH request for updating settings. Returns empty array by default (triggers INSERT).

#### `mockInsertSettings(response?, options?)`

Mocks POST request for inserting new settings.

### Event Handling (`env.event`)

Simulate Rimori events and actions.

#### `triggerOnSidePanelAction(payload: MainPanelAction)`

Triggers a side panel action event. Sets up a listener that responds when the plugin calls `onSidePanelAction()`.

**Important**: Call this BEFORE navigating to the page, so the listener is ready when the plugin initializes.

```typescript
await env.event.triggerOnSidePanelAction({
  plugin_id: pluginId,
  action_key: 'translate',
  action: 'translate',
  text: 'tree',
});

await page.goto(`${pluginUrl}/#/sidebar/translate`);
```

#### `triggerOnMainPanelAction(payload: MainPanelAction)`

Triggers a main panel action event. Sets up a listener that responds when the plugin calls `onMainPanelAction()`.

```typescript
await env.event.triggerOnMainPanelAction({
  plugin_id: pluginId,
  action_key: 'open',
  action: 'open',
});
```

### Mock Options

All mock methods accept an optional `MockOptions` parameter:

```typescript
interface MockOptions {
  // Delay before response (milliseconds)
  delay?: number;
  
  // Request matcher function
  matcher?: (request: Request) => boolean;
  
  // HTTP method override
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  
  // Custom response headers
  headers?: Record<string, string>;
  
  // Simulate network error
  error?: 'aborted' | 'connectionfailed' | 'timedout' | /* ... */;
}
```

**Example with matcher:**
```typescript
env.ai.mockGetObject(
  { result: 'data' },
  {
    matcher: (request) => {
      const body = request.postDataJSON();
      return body?.instructions?.includes('specific text') ?? false;
    },
    delay: 500, // Simulate network delay
  }
);
```

## Common Patterns

### Testing Settings Flow

The plugin settings flow involves GET → PATCH → POST:

1. **GET** - Check if settings exist (returns null if not found)
2. **PATCH** - Try to update (returns empty array if no rows updated)
3. **POST** - Insert new settings

The test environment sets up default handlers for all three, but you can override them:

```typescript
// Override to return existing settings
env.plugin.mockGetSettings({
  id: 'existing-id',
  plugin_id: pluginId,
  settings: { existing: 'data' },
});

// Override to simulate successful update (don't trigger INSERT)
env.plugin.mockSetSettings([{ id: 'updated-id' }]);
```

### Testing Action Events

Action events work differently for main panel vs sidebar:

**Side Panel Action:**
```typescript
// Plugin is on a sidebar page, uses onSidePanelAction()
await env.event.triggerOnSidePanelAction({
  plugin_id: pluginId,
  action_key: 'translate',
  action: 'translate',
  text: 'word',
});
```

**Main Panel Action:**
```typescript
// Plugin is on a main panel page, uses onMainPanelAction()
await env.event.triggerOnMainPanelAction({
  plugin_id: pluginId,
  action_key: 'open',
  action: 'open',
});
```

### Mocking Multiple Responses for Same Endpoint

Use matchers to provide different responses for the same endpoint:

```typescript
// First request - word lookup
env.ai.mockGetObject(
  { type: 'noun', translation: 'hund' },
  {
    matcher: (req) => {
      return req.postDataJSON()?.instructions?.includes('Look up') ?? false;
    },
  }
);

// Second request - example sentence
env.ai.mockGetObject(
  { example_sentence: { target_language: 'Jag har en hund.' } },
  {
    matcher: (req) => {
      return req.postDataJSON()?.instructions?.includes('example sentence') ?? false;
    },
    delay: 1000, // Simulate slower response
  }
);
```

## Examples

### Complete Translation Plugin Test

```typescript
import { test, expect } from '@playwright/test';
import { RimoriTestEnvironment } from '@rimori/playwright';

const pluginId = 'pl7720512027';
const pluginUrl = 'http://localhost:3009';

test.describe('Translator Plugin', () => {
  let env: RimoriTestEnvironment;

  test.beforeEach(async ({ page }) => {
    env = new RimoriTestEnvironment({ page, pluginId });

    // Mock translation lookup
    env.ai.mockGetObject(
      {
        gramatically_corrected_input_text: 'tree',
        detected_language: 'English',
        text_type: 'noun',
        translation_swedish: 'träd',
        translation_mother_tongue: 'tree',
        en_ett_word: 'ett',
      },
      {
        matcher: (req) => {
          return req.postDataJSON()?.instructions?.includes('Look up') ?? false;
        },
      }
    );

    // Mock example sentence (with delay)
    env.ai.mockGetObject(
      {
        example_sentence: {
          target_language: 'Jag ser ett träd.',
          english: 'I see a tree.',
        },
        explanation: 'A tall perennial plant.',
      },
      {
        delay: 1000,
        matcher: (req) => {
          return req.postDataJSON()?.instructions?.includes('example') ?? false;
        },
      }
    );

    await env.setup();
    await page.goto(`${pluginUrl}/#/sidebar/translate`);
  });

  test('translates word correctly', async ({ page }) => {
    await page.getByRole('textbox').fill('tree');
    await page.getByRole('button', { name: 'Look up word' }).click();

    await expect(page.getByText('träd')).toBeVisible();
    await expect(page.getByText('ett')).toBeVisible();
  });
});
```

### Testing with Side Panel Actions

```typescript
test('handles side panel action', async ({ page }) => {
  // Set up action BEFORE navigating
  await env.event.triggerOnSidePanelAction({
    plugin_id: pluginId,
    action_key: 'translate',
    action: 'translate',
    text: 'tree',
  });

  await page.goto(`${pluginUrl}/#/sidebar/translate`);

  // Plugin receives the action and starts translation
  await expect(page.getByText('träd')).toBeVisible();
});
```

### Testing Streaming Responses

```typescript
test('handles streaming chat responses', async ({ page }) => {
  // Mock streaming response for chat
  env.ai.mockGetSteamedText('This is the AI response that will be streamed.');

  await env.setup();
  await page.goto(`${pluginUrl}/#/sidebar/translate`);

  // Type a question
  await page.getByRole('textbox', { name: 'Ask questions...' }).fill('Explain this');
  await page.keyboard.press('Enter');

  // Response should appear (formatted as SSE)
  await expect(page.getByText('This is the AI response')).toBeVisible();
});
```

## Default Behavior

The test environment automatically provides:

- **Default RimoriInfo**: Test credentials, guild info, user profile
- **Default route handlers**: 
  - `GET /plugin_settings` → returns `null` (no settings)
  - `PATCH /plugin_settings` → returns `[]` (no rows updated, triggers INSERT)
  - `POST /plugin_settings` → returns success response
- **MessageChannel communication**: Fully set up and ready

You can override any of these defaults by calling the appropriate mock methods.

## Limitations

### Streaming Responses

Due to Playwright's `route.fulfill()` requiring a complete response body, streaming responses (via `mockGetSteamedText`) send all SSE chunks at once. The client will parse them correctly as SSE, but incremental timing/delays won't be visible in the UI.

For true streaming with visible delays, use a real HTTP server instead of route mocking.

### Standalone Mode

The test environment forces iframe mode (not standalone). Plugins that rely on standalone mode behavior may need different test setups.

## Troubleshooting

### "No route handler found"

If you see this error, add a mock for the missing route:

```typescript
env.plugin.mockGetSettings(null); // or env.ai.mockGetObject(...), etc.
```

### Plugin not receiving events

Make sure to call `triggerOnSidePanelAction` or `triggerOnMainPanelAction` BEFORE navigating:

```typescript
// ✅ Correct
await env.event.triggerOnSidePanelAction(payload);
await page.goto(pluginUrl);

// ❌ Wrong - listener not ready
await page.goto(pluginUrl);
await env.event.triggerOnSidePanelAction(payload);
```

### Settings not being saved

The default flow is: GET → PATCH (empty) → POST. If your test expects different behavior, override the handlers:

```typescript
// Simulate settings already exist
env.plugin.mockGetSettings({ id: 'existing', settings: {...} });
```

## License

Apache License 2.0

