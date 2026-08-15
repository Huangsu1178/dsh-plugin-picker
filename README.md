# dsh-plugin-picker

Codex-style plugin-package management for the DeepSeek Harness (DSH) Web GUI —
**standalone** (no dependency on the dsh-web-ui family bundle).

Typing `@` in the composer lists your installed plugin packages; picking one
injects its skills as `/skill` gestures so the host loads their instructions —
the same effect as referencing a plugin in Codex.

## Features

- **DSH-native plugin cache**: `~/.dsh/plugins/cache` is the source of truth.
- **Automatic Codex sync**: on startup (and via `POST /api/dsh-plugin-picker/sync`)
  plugin packages missing or older in the DSH cache are incrementally cloned
  from `~/.codex/plugins/cache` (version compare only — fast after the first
  run; ~160 MB one-time for a typical Codex cache).
- **`@` trigger menu**: lists enabled plugin packages (display name + summary),
  searchable by Chinese/English name and skill names.
- **Enable switches + nicknames**: per-package toggle and display nickname,
  editable in the official **plugin-config section** of the DSH settings page
  (the card registers into `settings.plugin.item` — no family bundle needed),
  or by hand in `~/.dsh/plugin-picker.json`:
  ```json
  { "enabled": { "github": false }, "nicknames": { "frontend-component-library": "前端组件库" } }
  ```
- **Loopback-fenced config API**:
  - `GET  /api/dsh-plugin-picker/plugins` — enabled packages (nickname applied)
  - `GET  /api/dsh-plugin-picker/config` — full list + config
  - `PUT  /api/dsh-plugin-picker/config` — merge + persist
  - `POST /api/dsh-plugin-picker/sync` — re-run the Codex → DSH sync

Only *plugin packages* are managed — any directory holding a
`.codex-plugin/plugin.json` manifest. Personal skills (e.g. in
`~/.agents/skills`) are never listed or synced.

## Install

```powershell
dsh plugin --profile web add link:<path-to-this-package>
# restart dsh web afterwards
```

Requires the DSH web profile only; the DSH core SDK packages
(`@deepseek-ai/*`) resolve from the web app itself.

## Config

Plugin config (schema in `src/index.ts`):

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for routes + `@` source |
| `pluginsDir` | `~/.dsh/plugins/cache` | DSH-native plugin cache (scanned/served) |
| `codexPluginsDir` | `~/.codex/plugins/cache` | Codex sync source |
| `syncFromCodex` | `true` | Clone missing/older packages on startup |
| `configFile` | `~/.dsh/plugin-picker.json` | Enable/nickname persistence |

## Build

```powershell
pnpm install
pnpm build
```

The build uses a vendored copy of the DSH client-bundle preset
(`build/tsdown.client.ts`, synced with `@deepseek-ai/dsh` versions; see the
file header). Publish to npm with `npm publish` (or `pnpm publish`) when ready.

## License

Apache-2.0
