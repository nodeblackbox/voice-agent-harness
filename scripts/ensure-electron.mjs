// Runs after `pnpm install`. pnpm only executes a dependency's install script when it is allow-listed
// (package.json → pnpm.onlyBuiltDependencies), and a store entry that was written without lifecycle scripts never
// runs one at all; either way Electron's binary is missing and `pnpm dev` stops with "Electron uninstall".
// This fetches it when it is not there, and is a no-op when it is.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
let pkgDir
try {
  pkgDir = dirname(require.resolve('electron/package.json'))
} catch {
  process.exit(0) // electron not installed at all (e.g. --prod); nothing to do
}
const binary = join(pkgDir, 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app' : 'electron')
if (existsSync(binary)) process.exit(0)
console.log('[postinstall] Electron binary is missing; downloading it (about 100 MB, once)')
const r = spawnSync(process.execPath, [join(pkgDir, 'install.js')], { stdio: 'inherit' })
process.exit(r.status ?? 1)
