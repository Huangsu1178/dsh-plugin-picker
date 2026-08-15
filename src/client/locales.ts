/** `plugin-picker` namespace dictionaries for the settings card. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'plugin-picker'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'settings.title': '插件包管理',
  'settings.description': '选择 Codex 插件包是否在 @ 菜单中启用，并自定义显示昵称。',
  'settings.nickname': '昵称',
  'settings.enabled': '启用',
  'settings.save': '保存',
  'settings.saving': '保存中…',
  'settings.error': '加载失败',
  'settings.saveError': '保存失败',
  'settings.unsaved': '有未保存的更改',
  'settings.expand': '展开',
  'settings.collapse': '收起',
  'settings.sync': '从 Codex 同步',
  'settings.syncing': '同步中…',
  'settings.syncDone': '同步完成（复制/跳过）：',
  'settings.syncError': '同步失败',
} as const

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'settings.title': 'Plugin Packages',
  'settings.description': 'Choose which Codex plugin packages appear in the @ menu and customize their display nicknames.',
  'settings.nickname': 'Nickname',
  'settings.enabled': 'Enabled',
  'settings.save': 'Save',
  'settings.saving': 'Saving…',
  'settings.error': 'Failed to load',
  'settings.saveError': 'Failed to save',
  'settings.unsaved': 'Unsaved changes',
  'settings.expand': 'Expand',
  'settings.collapse': 'Collapse',
  'settings.sync': 'Sync from Codex',
  'settings.syncing': 'Syncing…',
  'settings.syncDone': 'Sync done (copied/skipped): ',
  'settings.syncError': 'Sync failed',
} as const

/** Key set (zh is the source of truth). */
export type PluginPickerKey = keyof typeof zh
