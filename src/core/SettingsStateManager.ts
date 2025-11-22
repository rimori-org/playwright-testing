/**
 * Manages plugin settings state for test environment.
 * Provides a single source of truth for settings that can be modified by mocked API calls.
 */

export interface PluginSettings {
  id?: string;
  plugin_id?: string;
  guild_id?: string;
  settings?: Record<string, unknown>;
  is_guild_setting?: boolean;
  user_id?: string | null;
}

export class SettingsStateManager {
  private settings: PluginSettings | null;

  constructor(initialSettings: PluginSettings | null, pluginId: string, guildId: string) {
    this.settings = {
      id: initialSettings?.id ?? 'settings-id',
      plugin_id: initialSettings?.plugin_id ?? pluginId,
      guild_id: initialSettings?.guild_id ?? guildId,
      settings: initialSettings?.settings ?? {},
      is_guild_setting: initialSettings?.is_guild_setting ?? false,
      user_id: initialSettings?.user_id ?? null,
    };
  }

  /**
   * Get current settings state (for GET requests)
   * Returns null if no settings exist, otherwise returns the full settings object
   */
  getSettings(): PluginSettings | null {
    return this.settings;
  }

  /**
   * Update settings (for PATCH requests)
   * @param updates - Partial settings to update
   * @returns Array with updated row if settings exist, empty array if no settings exist
   */
  updateSettings(updates: Partial<PluginSettings>): PluginSettings[] {
    if (this.settings === null) {
      // No settings exist - PATCH returns empty array (triggers INSERT flow)
      return [];
    }

    // Update existing settings
    this.settings = {
      ...this.settings,
      ...updates,
      // Ensure these fields are preserved
      id: this.settings.id,
      plugin_id: this.settings.plugin_id,
      guild_id: this.settings.guild_id,
    };

    // PATCH returns array with updated row
    return [this.settings];
  }

  /**
   * Insert new settings (for POST requests)
   * @param newSettings - Settings to insert
   * @returns The inserted settings object
   */
  insertSettings(newSettings: Partial<PluginSettings>): PluginSettings {
    // Update existing settings with new values
    this.settings = {
      ...this.settings,
      ...newSettings,
    };

    return this.settings;
  }

  /**
   * Manually set settings (useful for test setup)
   */
  setSettings(settings: PluginSettings | null): void {
    this.settings = settings;
  }

  /**
   * Check if settings exist
   */
  hasSettings(): boolean {
    return this.settings !== null;
  }
}
