/**
 * Plugin-package settings card.
 *
 * Lists every plugin package with a nickname text input and an enable
 * toggle switch, staged locally and persisted through the host config route
 * (PUT /api/dsh-plugin-picker/config). The card is collapsible: the header
 * row toggles the whole configuration area (collapsed by default, so the
 * long plugin list never crowds the settings page).
 *
 * Failure policy: load/save failures show an inline error and never throw
 * into the boot path.
 */
import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { PLUGIN_PICKER_CONFIG } from '../protocol.ts'
import type { PluginPickerConfigResponse } from '../protocol.ts'
import type { PluginPickerKey } from './locales.ts'

/** Card props: the locale seat only (runtime/inject faces are unused). */
export type PluginPickerSettingsCardProps = PropsLocale<'plugin-picker'>

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 0',
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2, #d0d0d0)',
  background: 'var(--dsw-alias-bg-base, transparent)',
  color: 'inherit',
  fontSize: 13,
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  background: 'none',
  border: 'none',
  padding: '4px 0',
  cursor: 'pointer',
  color: 'inherit',
  fontSize: 14,
  fontWeight: 600,
  textAlign: 'left',
}

const chevronStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 16,
  height: 16,
  flex: 'none',
  transition: 'transform 0.15s ease',
  fontSize: 12,
}

const trackStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  width: 32,
  height: 18,
  borderRadius: 9,
  padding: 2,
  border: 'none',
  cursor: 'pointer',
  flex: 'none',
  transition: 'background 0.15s ease',
}

const thumbStyle: React.CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: 7,
  background: '#ffffff',
  boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
  flex: 'none',
}

/** One enable toggle switch (no checkbox, no extra deps). */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      onClick={() => onChange(!checked)}
      style={{
        ...trackStyle,
        background: checked
          ? 'var(--dsw-alias-accent-primary, #3b82f6)'
          : 'var(--dsw-alias-border-l2, #cbd5e1)',
        justifyContent: checked ? 'flex-end' : 'flex-start',
      }}
    >
      <span style={thumbStyle} />
    </button>
  )
}

/**
 * Render the plugin-package settings card (collapsible).
 * @param props - locale copy for this card.
 * @returns the card, or nothing while the config is still loading.
 */
export function PluginPickerSettingsCard(props: PluginPickerSettingsCardProps) {
  const { t } = props
  const [data, setData] = useState<PluginPickerConfigResponse | null>(null)
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [nicknames, setNicknames] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    fetch(PLUGIN_PICKER_CONFIG, { headers: { accept: 'application/json' } })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<PluginPickerConfigResponse>
      })
      .then((body) => {
        if (!alive) return
        setData(body)
        setEnabled({ ...body.enabled })
        setNicknames({ ...body.nicknames })
      })
      .catch((loadError) => {
        if (alive) setError(`${t('settings.error')}: ${String(loadError)}`)
      })
    return () => {
      alive = false
    }
  }, [t])

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(PLUGIN_PICKER_CONFIG, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled, nicknames }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as PluginPickerConfigResponse
      setData(body)
      setEnabled({ ...body.enabled })
      setNicknames({ ...body.nicknames })
    } catch (saveError) {
      setError(`${t('settings.saveError')}: ${String(saveError)}`)
    } finally {
      setSaving(false)
    }
  }

  if (data === null) return null

  const dirty = JSON.stringify(enabled) !== JSON.stringify(data.enabled) ||
    JSON.stringify(nicknames) !== JSON.stringify(data.nicknames)

  return (
    <li style={{ padding: '8px 0' }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={headerStyle}
        aria-expanded={open}
        aria-label={open ? t('settings.collapse') : t('settings.expand')}
      >
        <span style={{ ...chevronStyle, transform: open ? 'rotate(90deg)' : 'none' }} aria-hidden>
          ▶
        </span>
        <span>{t('settings.title')}</span>
        {dirty && <span style={{ fontSize: 12, opacity: 0.7, fontWeight: 400 }}>{t('settings.unsaved')}</span>}
      </button>
      {open && (
        <>
          <div style={{ opacity: 0.75, fontSize: 12, margin: '2px 0 6px' }}>{t('settings.description')}</div>
          {data.plugins.map((plugin) => (
            <div key={plugin.pluginName} style={rowStyle}>
              <Toggle
                checked={enabled[plugin.pluginName] ?? plugin.enabled}
                onChange={(next) => setEnabled((previous) => ({ ...previous, [plugin.pluginName]: next }))}
                label={`${t('settings.enabled')} ${plugin.pluginName}`}
              />
              <input
                type="text"
                style={inputStyle}
                value={nicknames[plugin.pluginName] ?? ''}
                placeholder={`${plugin.displayName} (${plugin.pluginName})`}
                onChange={(event) =>
                  setNicknames((previous) => ({ ...previous, [plugin.pluginName]: event.target.value }))
                }
                aria-label={`${t('settings.nickname')} ${plugin.pluginName}`}
              />
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              style={{ padding: '4px 14px', borderRadius: 6, cursor: saving || !dirty ? 'default' : 'pointer' }}
            >
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
            {dirty && <span style={{ fontSize: 12, opacity: 0.7 }}>{t('settings.unsaved')}</span>}
          </div>
          {error !== null && <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d03050)' }}>{error}</div>}
        </>
      )}
    </li>
  )
}
