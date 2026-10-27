// Load the plugin entry the way the Loader does, so a half-copied update fails here
// instead of at boot. `node --check` only parses; a missing imported file or a broken
// top-level import passes it and then crashes the whole web boot.
//
// Usage: node scripts/check-loadable.mjs [path/to/index.js]
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2] ?? 'plugins/mesh-waker/index.js'
const problems = []
let mod = null
try {
  mod = await import(pathToFileURL(path.resolve(entry)).href)
} catch (error) {
  console.error(`FAIL loadable: importing ${entry} threw: ${error.message}`)
  process.exit(1)
}
if (typeof mod.apply !== 'function') problems.push('missing apply() export')
if (typeof mod.name !== 'string' || !mod.name) problems.push('missing name export')
if (!Array.isArray(mod.inject)) problems.push('missing inject array')
if (problems.length) {
  console.error(`FAIL loadable: ${problems.join(', ')}`)
  process.exit(1)
}
console.log(`PASS loadable: ${mod.name} (inject: ${mod.inject.join(', ')})`)
