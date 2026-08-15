/**
 * Standalone build config for the plugin-package picker.
 *
 * Uses the vendored dsh client-bundle preset (build/tsdown.client.ts, copied
 * from the dsh checkout's packages/client/tsdown.client.ts via the dsh-web-ui
 * monorepo's shared preset; keep in sync when the dsh version changes): a
 * node-half lib/ plus the browser bundle lib/client.js (closure-factory
 * artifact for the GUI's __ModuleLoader__).
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@linxin666/dsh-client-ui-plugin-picker', ['src/index.ts', 'src/invariant.ts'], {
  libExternal: [],
})
