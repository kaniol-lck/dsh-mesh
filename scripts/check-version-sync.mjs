#!/usr/bin/env node
/**
 * check-version-sync.mjs — standing invariant: version numbers agree across each axis.
 *
 * hub axis:    hub/server.mjs HUB_VERSION = hub/package.json = hub/CHANGES.md top `## vX.Y.Z`
 * waker axis:  plugins/mesh-waker/package.json = CHANGELOG.md top `## vX.Y.Z`
 *
 * Exit 0 when both axes agree, 1 otherwise. `--json` for machine use.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

function packageVersion(rel) {
  return JSON.parse(read(rel)).version
}

function firstVersion(rel, pattern) {
  const match = pattern.exec(read(rel))
  return match ? match[1] : null
}

function main() {
  const json = process.argv.includes('--json')
  const hubVersion = firstVersion('hub/server.mjs', /HUB_VERSION\s*=\s*'([^']+)'/)
  const hubPackage = packageVersion('hub/package.json')
  const hubChangelog = firstVersion('hub/CHANGES.md', /^## v(\d+\.\d+\.\d+)/m)
  const wakerPackage = packageVersion('plugins/mesh-waker/package.json')
  const wakerChangelog = firstVersion('plugins/mesh-waker/CHANGELOG.md', /^## v(\d+\.\d+\.\d+)/m)
  const hubOk = hubVersion && hubVersion === hubPackage && hubVersion === hubChangelog
  const wakerOk = wakerPackage && wakerPackage === wakerChangelog
  const report = {
    hub: { server: hubVersion, package: hubPackage, changelog: hubChangelog, ok: Boolean(hubOk) },
    waker: { package: wakerPackage, changelog: wakerChangelog, ok: Boolean(wakerOk) },
    ok: Boolean(hubOk && wakerOk),
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`hub  ${hubOk ? 'OK  ' : 'FAIL'} HUB_VERSION=${hubVersion} package=${hubPackage} CHANGES=${hubChangelog}`)
    console.log(`waker ${wakerOk ? 'OK  ' : 'FAIL'} package=${wakerPackage} CHANGELOG=${wakerChangelog}`)
  }
  process.exit(report.ok ? 0 : 1)
}

main()
