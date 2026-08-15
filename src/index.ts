/**
 * Plugin-package picker — host half.
 *
 * Manages a DSH-native plugin cache at `~/.dsh/plugins/cache` and keeps it in
 * sync with the Codex plugins cache (`~/.codex/plugins/cache`): on startup
 * (and on demand) it incrementally clones plugin packages that are missing or
 * older in the DSH cache, so DSH owns an independent copy that survives Codex
 * cache cleanups. Only *plugin packages* are managed — any directory tree
 * holding a `.codex-plugin/plugin.json` manifest (personal skills in
 * `~/.agents/skills` are deliberately NOT plugin packages and are never
 * listed or synced).
 *
 * Routes (all loopback-fenced):
 *   GET  /api/dsh-plugin-picker/plugins     enabled packages (nickname applied)
 *   GET  /api/dsh-plugin-picker/config      full package list + enable/nickname config
 *   PUT  /api/dsh-plugin-picker/config      merge + persist enable/nickname config
 *   POST /api/dsh-plugin-picker/sync        re-run the Codex → DSH sync
 *   POST /api/dsh-plugin-picker/packages    create a plugin package (tool-backed)
 *
 * A `dsh_plugin_package_create` agent tool wraps the same creation path, so a
 * model can assemble skills into a Codex-compatible plugin package on demand.
 *
 * Config lives in `~/.dsh/plugin-picker.json` (enabled / nicknames maps), so
 * the user can edit it by hand or through the settings card.
 */

import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from 'schemastery'
import {
  PLUGIN_PICKER_CONFIG,
  PLUGIN_PICKER_PACKAGES,
  PLUGIN_PICKER_PLUGINS,
  PLUGIN_PICKER_SYNC,
  type CreatePackageRequest,
  type CreatePackageResult,
  type PluginPackageConfigRow,
  type PluginPackageSummary,
  type PluginPickerConfig,
  type PluginPickerConfigPatch,
  type PluginPickerConfigResponse,
  type PluginSkillSummary,
} from './protocol.ts'

/** Stable cordis plugin name. */
export const name = 'plugin-picker'

/** Services required before the routes and tool can mount. */
export const inject = ['webServer', 'tools']

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** Master switch for the routes + browser source. */
  enabled?: boolean
  /** DSH-native plugin cache root (scanned and served). */
  pluginsDir?: string
  /** Codex plugin cache root (sync source). */
  codexPluginsDir?: string
  /** Whether the startup sync clones the Codex cache into the DSH cache. */
  syncFromCodex?: boolean
  /** Where the enable/nickname config is persisted. */
  configFile?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  pluginsDir: z.string().default(join(homedir(), '.dsh', 'plugins', 'cache')),
  codexPluginsDir: z.string().default(join(homedir(), '.codex', 'plugins', 'cache')),
  syncFromCodex: z.boolean().default(true),
  configFile: z.string().default(join(homedir(), '.dsh', 'plugin-picker.json')),
})

/** Schema defaults, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_PLUGINS_DIR = join(homedir(), '.dsh', 'plugins', 'cache')
const DEFAULT_CODEX_DIR = join(homedir(), '.codex', 'plugins', 'cache')
const DEFAULT_CONFIG_FILE = join(homedir(), '.dsh', 'plugin-picker.json')

/** Walk-depth cap: the cache layout is <root>/<plugin>/[<plugin>/]<version>/.codex-plugin/plugin.json. */
const MAX_WALK_DEPTH = 6

/** Cap on JSON request bodies (config patches are small). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** One discovered plugin package. */
interface PluginPackageEntry {
  readonly pluginName: string
  readonly version: string
  /** Directory holding `.codex-plugin/plugin.json` (the version dir). */
  readonly pkgDir: string
}

// ---------------------------------------------------------------------------
// Small HTTP helpers (loopback fence + JSON), mirroring dsh-ssh.
// ---------------------------------------------------------------------------

/** Loopback literal check plus browser same-origin markers. */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Send a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Read a JSON request body (size-capped). */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_JSON_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// ---------------------------------------------------------------------------
// Sync: clone the Codex cache into the DSH cache (incremental).
// ---------------------------------------------------------------------------

/** Read a file, returning undefined on absence/errors. */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Walk the tree (depth-capped) collecting every `.codex-plugin/plugin.json`. */
async function findManifests(root: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '.codex-plugin') {
        if (await readOptional(join(full, 'plugin.json')) !== undefined) out.push(join(full, 'plugin.json'))
      } else {
        await findManifests(full, depth + 1, out)
      }
    }
  }
}

/** Compare two dotted versions; -1 / 0 / 1. */
function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => (part.match(/^\d+$/) ? Number(part) : 0))
  const pb = b.split(/[.-]/).map((part) => (part.match(/^\d+$/) ? Number(part) : 0))
  const length = Math.max(pa.length, pb.length)
  for (let i = 0; i < length; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** Discover one package per plugin name (latest version wins) under a cache root. */
async function findPluginPackages(root: string): Promise<PluginPackageEntry[]> {
  const manifests: string[] = []
  await findManifests(root, 0, manifests)
  const byName = new Map<string, PluginPackageEntry>()
  for (const manifestPath of manifests) {
    const raw = await readOptional(manifestPath)
    if (raw === undefined) continue
    let manifest: { name?: unknown; version?: unknown }
    try {
      manifest = JSON.parse(raw) as { name?: unknown; version?: unknown }
    } catch {
      continue
    }
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) continue
    const entry: PluginPackageEntry = {
      pluginName: manifest.name,
      version: typeof manifest.version === 'string' ? manifest.version : '',
      pkgDir: join(manifestPath, '..', '..'),
    }
    const existing = byName.get(entry.pluginName)
    if (existing === undefined || compareVersion(entry.version, existing.version) > 0) {
      byName.set(entry.pluginName, entry)
    }
  }
  return [...byName.values()]
}

/** Existing version directories of one plugin in the DSH cache. */
async function existingVersions(dshRoot: string, pluginName: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dshRoot, pluginName), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * Clone Codex plugin packages missing or older in the DSH cache. Only the
 * latest version of each Codex plugin is mirrored; packages already present
 * at the same or newer version are skipped, and excluded plugin names are
 * never cloned (they were removed by the user).
 */
async function syncFromCodex(
  dshRoot: string,
  codexRoot: string,
  excluded: readonly string[],
): Promise<{ copied: number; skipped: number }> {
  const packages = (await findPluginPackages(codexRoot)).filter((pkg) => !excluded.includes(pkg.pluginName))
  let copied = 0
  let skipped = 0
  for (const pkg of packages) {
    const versions = await existingVersions(dshRoot, pkg.pluginName)
    const newest = versions.sort(compareVersion).at(-1)
    if (newest !== undefined && compareVersion(newest, pkg.version) >= 0) {
      skipped++
      continue
    }
    await mkdir(join(dshRoot, pkg.pluginName), { recursive: true })
    const dest = join(dshRoot, pkg.pluginName, pkg.version)
    await cp(pkg.pkgDir, dest, { recursive: true, force: false })
    copied++
  }
  return { copied, skipped }
}

// ---------------------------------------------------------------------------
// Config store (~/.dsh/plugin-picker.json).
// ---------------------------------------------------------------------------

/** Loads, mutates, and persists the enable/nickname config. */
class ConfigStore {
  private value: PluginPickerConfig

  constructor(private readonly file: string) {
    this.value = this.load()
  }

  private load(): PluginPickerConfig {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as PluginPickerConfig
      return {
        enabled: typeof parsed.enabled === 'object' && parsed.enabled !== null ? parsed.enabled : {},
        nicknames: typeof parsed.nicknames === 'object' && parsed.nicknames !== null ? parsed.nicknames : {},
        excluded: Array.isArray(parsed.excluded) ? parsed.excluded : [],
      }
    } catch {
      return { enabled: {}, nicknames: {}, excluded: [] }
    }
  }

  /** Apply a partial patch and persist. Returns the merged config. */
  update(patch: PluginPickerConfigPatch): PluginPickerConfig {
    const enabled = { ...(this.value.enabled ?? {}), ...(patch.enabled ?? {}) }
    const nicknames = { ...(this.value.nicknames ?? {}), ...(patch.nicknames ?? {}) }
    const excluded = [...new Set([...(this.value.excluded ?? []), ...(patch.excluded ?? [])])]
    this.value = { enabled, nicknames, excluded }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.value, null, 2), 'utf8')
    } catch (error) {
      throw new Error(`failed to persist plugin-picker config: ${String(error)}`)
    }
    return this.value
  }

  get(): PluginPickerConfig {
    return this.value
  }
}

// ---------------------------------------------------------------------------
// Scan (DSH cache) + route responses.
// ---------------------------------------------------------------------------

/** Extract the kebab `name` from a SKILL.md frontmatter block. */
function skillNameFromMarkdown(raw: string): string | undefined {
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!block) return undefined
  const match = block[1].match(/^name:\s*([^\s]+)/m)
  return match?.[1]
}

/** Read the skills shipped in `<pkgRoot>/skills/` (one level of SKILL.md dirs). */
async function readSkills(pkgRoot: string): Promise<PluginSkillSummary[]> {
  try {
    const entries = await readdir(join(pkgRoot, 'skills'), { withFileTypes: true })
    const skills: PluginSkillSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const raw = await readOptional(join(pkgRoot, 'skills', entry.name, 'SKILL.md'))
      if (raw === undefined) continue
      const skillName = skillNameFromMarkdown(raw)
      if (skillName === undefined) continue
      skills.push({ name: skillName })
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/** Parse one plugin package into a summary (skills read from the package root). */
async function readPlugin(pkgDir: string): Promise<PluginPackageSummary | undefined> {
  const raw = await readOptional(join(pkgDir, '.codex-plugin', 'plugin.json'))
  if (raw === undefined) return undefined
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) return undefined
  const pluginName = manifest.name
  const version = typeof manifest.version === 'string' ? manifest.version : ''
  const skills = await readSkills(pkgDir)
  const iface = typeof manifest.interface === 'object' && manifest.interface !== null
    ? (manifest.interface as Record<string, unknown>)
    : {}
  const displayName = typeof iface.displayName === 'string' && iface.displayName.length > 0
    ? iface.displayName
    : pluginName
  const shortDescription = typeof iface.shortDescription === 'string' && iface.shortDescription.length > 0
    ? iface.shortDescription
    : typeof manifest.description === 'string'
      ? manifest.description
      : ''
  return { pluginName, version, displayName, shortDescription, skills }
}

/** Scan a cache root: one summary per plugin name, latest version wins. */
async function scanPlugins(root: string): Promise<PluginPackageSummary[]> {
  const packages = await findPluginPackages(root)
  const summaries: PluginPackageSummary[] = []
  for (const pkg of packages) {
    const plugin = await readPlugin(pkg.pkgDir)
    if (plugin === undefined) continue
    summaries.push(plugin)
  }
  return summaries.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh'))
}

// ---------------------------------------------------------------------------
// Create: assemble skills into a Codex-compatible plugin package.
// ---------------------------------------------------------------------------

/** Kebab-case name grammar (same as skill names). */
const KEBAB_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Codex plugin-creator cap: plugin names are at most 64 characters. */
const MAX_PLUGIN_NAME_LENGTH = 64

/** Codex plugin-creator defaults. */
const DEFAULT_AUTHOR = 'Local developer'
const DEFAULT_CATEGORY = 'Productivity'

/** Skill library the create path packs from. */
const SKILL_LIBRARY = join(homedir(), '.agents', 'skills')

/** Derive a Title-Case display name from a kebab plugin name (Codex plugin-creator style). */
function displayNameFromPluginName(pluginName: string): string {
  return pluginName
    .split(/[-_]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Create a plugin package directory under the DSH cache, following the Codex
 * plugin-creator manifest shape:
 * `<pluginsDir>/<name>/<version>/` with `.codex-plugin/plugin.json`
 * (author + full interface, `defaultPrompt` included — the Codex validator
 * requires it) and `skills/<skill>/`. Skills are either packed from the
 * skill library (`sourceSkill`) or written inline (`content`).
 * @param pluginsDir - DSH plugin cache root.
 * @param request - creation input.
 * @returns the created package summary.
 */
async function createPackage(pluginsDir: string, request: CreatePackageRequest): Promise<CreatePackageResult> {
  const pluginName = request.name
  if (typeof pluginName !== 'string' || !KEBAB_NAME.test(pluginName)) {
    throw new Error(`invalid plugin name "${pluginName}" (kebab-case required)`)
  }
  if (pluginName.length > MAX_PLUGIN_NAME_LENGTH) {
    throw new Error(`plugin name too long (${pluginName.length} chars; max ${MAX_PLUGIN_NAME_LENGTH})`)
  }
  const version = typeof request.version === 'string' && request.version.length > 0 ? request.version : '0.1.0'
  const dest = join(pluginsDir, pluginName, version)
  if (existsSync(dest)) throw new Error(`plugin package already exists: ${pluginName}@${version}`)

  const skills = Array.isArray(request.skills) ? request.skills : []
  for (const skill of skills) {
    if (typeof skill?.name !== 'string' || !KEBAB_NAME.test(skill.name)) {
      throw new Error(`invalid skill name "${skill?.name}" (kebab-case required)`)
    }
    if (typeof skill.content === 'string' && skill.content.length > 0) continue
    const sourceName = typeof skill.sourceSkill === 'string' && skill.sourceSkill.length > 0 ? skill.sourceSkill : skill.name
    if (!existsSync(join(SKILL_LIBRARY, sourceName, 'SKILL.md'))) {
      throw new Error(`source skill not found: ${sourceName}`)
    }
  }

  await mkdir(join(dest, '.codex-plugin'), { recursive: true })
  await mkdir(join(dest, 'skills'), { recursive: true })
  const displayName = typeof request.displayName === 'string' && request.displayName.length > 0
    ? request.displayName
    : displayNameFromPluginName(pluginName)
  const description = typeof request.description === 'string' && request.description.length > 0
    ? request.description
    : `${displayName} plugin`
  const authorName = typeof request.authorName === 'string' && request.authorName.length > 0
    ? request.authorName
    : DEFAULT_AUTHOR
  const category = typeof request.category === 'string' && request.category.length > 0
    ? request.category
    : DEFAULT_CATEGORY
  const defaultPrompt = typeof request.defaultPrompt === 'string' && request.defaultPrompt.length > 0
    ? request.defaultPrompt
    : `Help me use ${displayName}.`
  await writeFile(
    join(dest, '.codex-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: pluginName,
        version,
        description,
        author: { name: authorName },
        skills: './skills/',
        interface: {
          displayName,
          shortDescription: description,
          longDescription: description,
          developerName: authorName,
          category,
          capabilities: [],
          defaultPrompt,
        },
      },
      null,
      2,
    ),
    'utf8',
  )

  const written: string[] = []
  for (const skill of skills) {
    const skillName = skill.name
    const skillDir = join(dest, 'skills', skillName)
    if (typeof skill.content === 'string' && skill.content.length > 0) {
      await mkdir(skillDir, { recursive: true })
      await writeFile(join(skillDir, 'SKILL.md'), skill.content, 'utf8')
    } else {
      const sourceName = typeof skill.sourceSkill === 'string' && skill.sourceSkill.length > 0 ? skill.sourceSkill : skillName
      await cp(join(SKILL_LIBRARY, sourceName), skillDir, { recursive: true })
    }
    written.push(skillName)
  }

  // Self-check against the Codex plugin-creator validator's core requirements.
  const manifestPath = join(dest, '.codex-plugin', 'plugin.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const iface = typeof manifest.interface === 'object' && manifest.interface !== null
    ? (manifest.interface as Record<string, unknown>)
    : {}
  const prompt = iface.defaultPrompt ?? iface.default_prompt
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('self-check failed: plugin.json interface.defaultPrompt is required')
  }

  return { pluginName, version, path: dest, skills: written }
}

/**
 * Mount the sync + scan + config routes.
 * @param ctx - host plugin context carrying webServer.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const pluginsDir = config?.pluginsDir ?? DEFAULT_PLUGINS_DIR
  const codexDir = config?.codexPluginsDir ?? DEFAULT_CODEX_DIR
  const syncEnabled = config?.syncFromCodex ?? true
  const store = new ConfigStore(config?.configFile ?? DEFAULT_CONFIG_FILE)

  // One shared sync promise so concurrent route calls wait for the same run.
  let syncPromise: Promise<{ copied: number; skipped: number }> | null = null
  const ensureSync = (): Promise<{ copied: number; skipped: number }> => {
    if (syncPromise === null) {
      syncPromise = (syncEnabled
        ? syncFromCodex(pluginsDir, codexDir, store.get().excluded ?? [])
        : Promise.resolve({ copied: 0, skipped: 0 }))
        .catch((error) => {
          ctx.logger.warn(`plugin-picker: codex sync failed: ${String(error)}`)
          return { copied: 0, skipped: 0 }
        })
        .finally(() => {
          syncPromise = null
        })
    }
    return syncPromise
  }

  // Startup: kick the sync so the DSH cache is current before first use.
  void ensureSync()

  // Agent tool: create a plugin package (same path as POST /packages).
  ctx.effect(() => {
    const disposer = ctx.tools.register(
      defineTool({
        name: 'dsh_plugin_package_create',
        description:
          'Create a new Codex-compatible plugin package in the DSH plugin cache (~/.dsh/plugins/cache), so it appears in the @ menu immediately. ' +
          'The manifest follows the Codex plugin-creator shape: .codex-plugin/plugin.json with author + full interface (displayName, category, defaultPrompt), and skills/ directories. ' +
          'Skills can be packed from the existing skill library (~/.agents/skills) via sourceSkill, or created inline via content (full SKILL.md body). ' +
          'Triggers: create plugin package / skill plugin pack, package skills into a plugin, 创建插件包 / 打包技能成插件.',
        parameters: {
          name: { type: 'string', description: 'Plugin package name, kebab-case, at most 64 chars (required).', required: true },
          displayName: { type: 'string', description: 'Display name (defaults to Title-Case derivation of name).' },
          description: { type: 'string', description: 'Short description (defaults to "<DisplayName> plugin").' },
          version: { type: 'string', description: 'Version, dotted (default 0.1.0).' },
          authorName: { type: 'string', description: 'Publisher name for author/developerName (default "Local developer").' },
          category: { type: 'string', description: 'Interface category (default "Productivity").' },
          defaultPrompt: { type: 'string', description: 'Interface defaultPrompt, required by the Codex validator (default "Help me use <DisplayName>.").' },
          skills: {
            type: 'array',
            description: 'Skills to include in the package.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: 'Target skill name inside the package (kebab).', required: true },
                sourceSkill: { type: 'string', description: 'Pack this existing skill from ~/.agents/skills (defaults to name).' },
                content: { type: 'string', description: 'Or the full SKILL.md body for a brand-new skill.' },
              },
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              pluginName: { type: 'string', required: true },
              version: { type: 'string', required: true },
              path: { type: 'string', required: true },
              skills: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
          render: (_args, value: CreatePackageResult) => [
            { type: 'text', text: `created plugin package ${value.pluginName}@${value.version} at ${value.path}\nskills: ${value.skills.join(', ')}` },
          ] as ContentBlock[],
        },
        async execute(args) {
          return await createPackage(pluginsDir, args)
        },
      }),
    )
    return disposer
  }, 'plugin-picker: create tool')

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: PLUGIN_PICKER_PACKAGES,
        handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
          if (!isLoopbackRequest(request)) return json(response, 403, { error: 'loopback only' })
          if (request.method !== 'POST') return json(response, 405, { error: 'method not allowed' })
          try {
            const body = (await readJsonBody(request)) as CreatePackageRequest
            const result = await createPackage(pluginsDir, body)
            json(response, 200, result)
          } catch (error) {
            json(response, 400, { error: String(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PLUGIN_PICKER_PLUGINS,
        handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
          if (!isLoopbackRequest(request)) return json(response, 403, { error: 'loopback only' })
          try {
            await ensureSync()
            const configValue = store.get()
            const plugins = await scanPlugins(pluginsDir)
            const visible = plugins
              .filter((plugin) => !(configValue.excluded ?? []).includes(plugin.pluginName))
              .filter((plugin) => (configValue.enabled?.[plugin.pluginName] ?? true) !== false)
              .map((plugin) => ({
                ...plugin,
                displayName: configValue.nicknames?.[plugin.pluginName] ?? plugin.displayName,
              }))
            json(response, 200, { plugins: visible })
          } catch (error) {
            json(response, 500, { error: String(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PLUGIN_PICKER_CONFIG,
        handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
          if (!isLoopbackRequest(request)) return json(response, 403, { error: 'loopback only' })
          try {
            if (request.method === 'PUT') {
              const patch = (await readJsonBody(request)) as PluginPickerConfigPatch
              const saved = store.update({
                enabled: typeof patch?.enabled === 'object' && patch.enabled !== null ? patch.enabled : undefined,
                nicknames: typeof patch?.nicknames === 'object' && patch.nicknames !== null ? patch.nicknames : undefined,
                excluded: Array.isArray(patch?.excluded) ? patch.excluded : undefined,
              })
              return json(response, 200, configResponse(await scanPlugins(pluginsDir), saved))
            }
            await ensureSync()
            json(response, 200, configResponse(await scanPlugins(pluginsDir), store.get()))
          } catch (error) {
            json(response, 400, { error: String(error) })
          }
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: PLUGIN_PICKER_SYNC,
        handler: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
          if (!isLoopbackRequest(request)) return json(response, 403, { error: 'loopback only' })
          try {
            const result = await ensureSync()
            json(response, 200, result)
          } catch (error) {
            json(response, 500, { error: String(error) })
          }
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'plugin-picker: routes')
}

/** Compose the config route payload. */
function configResponse(
  plugins: PluginPackageSummary[],
  configValue: PluginPickerConfig,
): PluginPickerConfigResponse {
  const excluded = configValue.excluded ?? []
  const rows: PluginPackageConfigRow[] = plugins
    .filter((plugin) => !excluded.includes(plugin.pluginName))
    .map((plugin) => ({
      pluginName: plugin.pluginName,
      displayName: plugin.displayName,
      version: plugin.version,
      skills: plugin.skills.map((skill) => skill.name),
      enabled: (configValue.enabled?.[plugin.pluginName] ?? true) !== false,
    }))
  return {
    enabled: configValue.enabled ?? {},
    nicknames: configValue.nicknames ?? {},
    excluded,
    plugins: rows,
  }
}
