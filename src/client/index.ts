/**
 * Plugin-package picker — browser half.
 *
 * Registers an '@' trigger source ("插件包") that lists the enabled plugin
 * packages served by the host route (the host applies the user's enable
 * switches and nicknames). Picking a package inserts the plugin's display
 * name plus `/skill` gestures for its skills that exist in the current
 * session's skill catalog — the host's existing skill-invocation path then
 * injects those skill bodies, giving the same "reference a plugin package"
 * effect as Codex's '@' mention.
 *
 * Also registers the plugin-package settings card (enable switch + nickname
 * per package) into the official `settings.plugin.item` slot, backed by the
 * host config route — no dsh-web-ui family bundle required.
 *
 * For known multi-skill plugins a baked PRIMARY_SKILLS table narrows the
 * injection to the router/entry skills; the model loads siblings via the
 * `skill` tool from the always-visible catalog.
 *
 * Failure policy: nothing may throw into the boot path. Route/catalog fetch
 * failures degrade to an empty menu (or a bare '@name' insert), never a
 * broken GUI.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CandidateRequest,
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { PLUGIN_PICKER_PLUGINS, type PluginPackageSummary } from '../protocol.ts'
import { en, zh, type PluginPickerKey } from './locales.ts'
import { PluginPickerSettingsCard } from './settings-card.tsx'

/** Locale namespace this plugin owns. */
const NS = 'plugin-picker'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin-picker surface copy (settings card). */
    'plugin-picker': PluginPickerKey
  }

  interface SlotMap {
    /**
     * The official plugin-config section renders this slot; the card shows
     * up there without any dependency on the dsh-web-ui family bundle.
     */
    'settings.plugin.item': { kind: 'list'; scope: 'root'; owner: { children?: never } }
  }
}

/** Localized candidate: pick data rides private fields (the menu ignores them). */
interface PluginCandidate extends InputTriggerCandidate {
  __pluginName?: string
  __displayName?: string
  __skills?: readonly string[]
}

/**
 * For known multi-skill plugins, only these router/entry skills are injected
 * on pick; everything else is left to the model via the skill catalog.
 */
const PRIMARY_SKILLS: Readonly<Record<string, readonly string[]>> = {
  'frontend-component-library': ['design-frontend-page', 'select-frontend-component'],
}

/** Session-scoped route fetch cache. */
const fetches = new Map<string, Promise<PluginPackageSummary[]>>()

/** Fetch the enabled plugin-package list from the host route (cached per session). */
function fetchPlugins(sessionId: string): Promise<PluginPackageSummary[]> {
  const existing = fetches.get(sessionId)
  if (existing !== undefined) return existing
  const promise = (async () => {
    const response = await fetch(PLUGIN_PICKER_PLUGINS, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`plugin-picker list failed: HTTP ${response.status}`)
    const body = (await response.json()) as { plugins?: PluginPackageSummary[] }
    return body.plugins ?? []
  })()
  fetches.set(sessionId, promise)
  promise.catch(() => {
    fetches.delete(sessionId)
  })
  return promise
}

/** Required services: the '@' source registry, the connection API, slots, locale. */
export const inject = ['inputTriggers', 'connection', 'slots', 'locale']

/**
 * Register the '@' plugin-package source and the settings card.
 * @param ctx - client root context (inputTriggers, connection, slots, locale).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-picker: dictionaries')

  const inputTriggers = ctx.get('inputTriggers') as unknown as {
    registerSource(source: InputTriggerSource): () => void
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const slots = ctx.get('slots')

  /** The session's skill catalog names (drives availability). */
  const fetchCatalogNames = async (sessionId: SessionId, signal: AbortSignal): Promise<Set<string>> => {
    try {
      const { result } = await connection.api.skills.list({ sessionId }, signal)
      if (!result.ok) return new Set()
      return new Set(result.value.skills.map((skill: { name: string }) => skill.name))
    } catch {
      return new Set()
    }
  }

  const source: InputTriggerSource = {
    trigger: '@',
    name: '插件包',
    order: 1,
    async candidates(session: ClientSessionContext, request: CandidateRequest): Promise<readonly InputTriggerCandidate[]> {
      let plugins: PluginPackageSummary[]
      try {
        plugins = await fetchPlugins(session.sessionId)
      } catch (error) {
        console.error('[dsh-client-ui-plugin-picker] list failed:', error)
        return []
      }
      if (request.signal.aborted) return []
      const names = await fetchCatalogNames(session.sessionId, request.signal)
      const query = request.query.trim().toLowerCase()
      const out: PluginCandidate[] = []

      // Fixed "create a plugin package" entry, always first.
      const createLabel = '＋ 新建插件包 (create)'
      if (query === '' || createLabel.toLowerCase().includes(query)) {
        out.push({
          name: createLabel,
          description: '把技能打包成一个新的 Codex 插件包（工具：dsh_plugin_package_create）',
          __pluginName: '__create__',
          __displayName: '新建插件包',
          __skills: [],
        })
      }

      for (const plugin of plugins) {
        const haystack = `${plugin.displayName} ${plugin.pluginName} ${plugin.shortDescription} ${plugin.skills
          .map((skill) => skill.name)
          .join(' ')}`.toLowerCase()
        if (query !== '' && !haystack.includes(query)) continue
        const skills = (PRIMARY_SKILLS[plugin.pluginName] ?? plugin.skills.map((skill) => skill.name)).filter((skillName) =>
          names.has(skillName),
        )
        out.push({
          name: `${plugin.displayName} (${plugin.pluginName})`,
          description: plugin.shortDescription,
          __pluginName: plugin.pluginName,
          __displayName: plugin.displayName,
          __skills: skills,
        })
      }
      return out
    },
    warm(session: ClientSessionContext): void {
      fetchPlugins(session.sessionId).catch(() => {})
    },
    onPick(pick: InputTriggerPick): PickOutcome {
      const candidate = pick.candidate as PluginCandidate
      if (candidate.__pluginName === '__create__') {
        return {
          text:
            '请用 dsh_plugin_package_create 工具创建一个新的插件包：' +
            '名称（kebab-case）：____；显示名：____；描述：____；' +
            '包含技能：____（现有技能名，或以 SKILL.md 内容新建） ',
        }
      }
      const displayName = candidate.__displayName ?? candidate.name
      const gestures = (candidate.__skills ?? []).map((skillName) => `/${skillName}`).join(' ')
      return { text: `@${displayName} ${gestures} `.trimEnd() + ' ' }
    },
  }

  try {
    ctx.effect(() => inputTriggers.registerSource(source), 'plugin-picker: @ source')
  } catch (error) {
    console.error('[dsh-client-ui-plugin-picker] register failed:', error)
  }

  // Plugin-package settings card: enable switches + nicknames, registered in
  // the official plugin-config section (no family-bundle dependency).
  try {
    if (slots === undefined) throw new Error('slots service unavailable')
    slots.inject('settings.plugin.item', () =>
      slots.register(
        {
          name: 'settings.plugin.item',
          id: 'plugin-picker',
          order: 120,
          locale: NS,
        },
        PluginPickerSettingsCard,
      ),
    )
  } catch (error) {
    console.error('[dsh-client-ui-plugin-picker] settings card register failed:', error)
  }
}
