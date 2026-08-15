/**
 * Shared wire types between the plugin-picker host half (scan / sync /
 * config) and the browser half ('@' trigger source + settings card).
 */

/** One skill shipped inside a plugin package's `skills/` directory. */
export interface PluginSkillSummary {
  /** kebab skill name from the SKILL.md frontmatter. */
  readonly name: string
  /** Short frontmatter description (may be bilingual). */
  readonly description?: string
}

/** One installed plugin package (identified by `.codex-plugin/plugin.json`). */
export interface PluginPackageSummary {
  /** plugin.json `name` (kebab). */
  readonly pluginName: string
  /** plugin.json `version`. */
  readonly version: string
  /** User-configured nickname, falling back to interface.displayName / name. */
  readonly displayName: string
  /** plugin.json `interface.shortDescription` / `description` fallback. */
  readonly shortDescription: string
  /** Skills shipped inside `<pkg>/skills/`. */
  readonly skills: readonly PluginSkillSummary[]
}

/** One plugin package as the settings card lists it (all packages, with state). */
export interface PluginPackageConfigRow {
  readonly pluginName: string
  readonly displayName: string
  readonly version: string
  readonly skills: readonly string[]
  readonly enabled: boolean
}

/** Persisted user configuration (file: ~/.dsh/plugin-picker.json). */
export interface PluginPickerConfig {
  /** Per-plugin enable switch; absent means enabled. */
  readonly enabled?: Readonly<Record<string, boolean>>
  /** Per-plugin display nickname overriding interface.displayName. */
  readonly nicknames?: Readonly<Record<string, string>>
}

/** Config route payload: the persisted config plus the full plugin list. */
export interface PluginPickerConfigResponse {
  readonly enabled: Readonly<Record<string, boolean>>
  readonly nicknames: Readonly<Record<string, string>>
  readonly plugins: readonly PluginPackageConfigRow[]
}

/** Body accepted by PUT /config (partial merge). */
export interface PluginPickerConfigPatch {
  readonly enabled?: Readonly<Record<string, boolean>>
  readonly nicknames?: Readonly<Record<string, string>>
}

/** One skill to include when creating a plugin package. */
export interface CreatePackageSkillInput {
  /** Target skill name inside the package (kebab). */
  readonly name: string
  /** Pack an existing skill by copying its directory from the skill library. */
  readonly sourceSkill?: string
  /** Or inline SKILL.md body for a brand-new skill. */
  readonly content?: string
}

/** Body accepted by POST /packages (create a plugin package). */
export interface CreatePackageRequest {
  /** Plugin package name (kebab). */
  readonly name: string
  /** Display name (defaults to `name`). */
  readonly displayName?: string
  /** Short description. */
  readonly description?: string
  /** Version (defaults to 0.1.0). */
  readonly version?: string
  /** Skills to include (pack existing or inline content). */
  readonly skills?: readonly CreatePackageSkillInput[]
}

/** Result of a successful package creation. */
export interface CreatePackageResult {
  readonly pluginName: string
  readonly version: string
  /** Absolute path of the created package directory. */
  readonly path: string
  /** Skill names actually written into the package. */
  readonly skills: readonly string[]
}

/** Host routes. */
export const PLUGIN_PICKER_API = '/api/dsh-plugin-picker'
export const PLUGIN_PICKER_PLUGINS = `${PLUGIN_PICKER_API}/plugins`
export const PLUGIN_PICKER_CONFIG = `${PLUGIN_PICKER_API}/config`
export const PLUGIN_PICKER_SYNC = `${PLUGIN_PICKER_API}/sync`
export const PLUGIN_PICKER_PACKAGES = `${PLUGIN_PICKER_API}/packages`
