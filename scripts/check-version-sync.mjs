#!/usr/bin/env node
/**
 * check-version-sync.mjs — standing invariant: version numbers agree across each axis.
 *
 * Sources (Keep a Changelog format, `## [x.y.z] - YYYY-MM-DD`, optional `## [未发布]`):
 *   hub:      hub/server.mjs HUB_VERSION = hub/package.json = hub/CHANGELOG.md latest released
 *   waker:    plugins/mesh-waker/package.json vs CHANGELOG latest released
 *             (an `[未发布]` section may keep the package version ahead of the last
 *              release — that is reported as `unreleased 0.7.30 > 0.7.5`)
 *   approval: plugins/mesh-approval/plugin.yaml version = its CHANGELOG latest released
 *
 * Missing files are reported as `MISSING: <path>` with exit 1, never a crash.
 * Exit codes: 0 consistent, 1 mismatch or missing file, 2 usage error.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

let ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `check-version-sync.mjs — versions must agree across each axis

Usage:
  node check-version-sync.mjs [--root <dir>] [--json]
  node check-version-sync.mjs --help

Exit codes: 0 consistent, 1 mismatch or missing file, 2 usage error.`

const RELEASED = /^## \[(\d+\.\d+\.\d+)\]/
const UNRELEASED = /^## \[未发布\]/

function parseArgs(argv) {
  const options = { json: false, root: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--root') {
      options.root = argv[index + 1]
      if (options.root === undefined) {
        console.error('--root requires a value\n\n' + USAGE)
        process.exit(2)
      }
      index += 1
    }
    else if (arg === '-h' || arg === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n\n${USAGE}`)
      process.exit(2)
    }
  }
  return options
}

function read(rel) {
  try {
    return readFileSync(path.join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

/** { latest, unreleased } from a Keep-a-Changelog file; latest = first released heading. */
export function changelogVersions(text) {
  let latest = null
  let unreleased = false
  for (const line of text.split(/\r?\n/)) {
    if (UNRELEASED.test(line)) {
      unreleased = true
      continue
    }
    const match = RELEASED.exec(line)
    if (match) {
      latest = match[1]
      break
    }
  }
  return { latest, unreleased }
}

function compareSemver(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.root) ROOT = path.resolve(options.root)
  const missing = []

  const serverText = read('hub/server.mjs')
  if (serverText === null) missing.push('hub/server.mjs')
  const hubPackageText = read('hub/package.json')
  if (hubPackageText === null) missing.push('hub/package.json')
  const hubChangelogText = read('hub/CHANGELOG.md')
  if (hubChangelogText === null) missing.push('hub/CHANGELOG.md')
  const wakerPackageText = read('plugins/mesh-waker/package.json')
  if (wakerPackageText === null) missing.push('plugins/mesh-waker/package.json')
  const wakerChangelogText = read('plugins/mesh-waker/CHANGELOG.md')
  if (wakerChangelogText === null) missing.push('plugins/mesh-waker/CHANGELOG.md')
  const approvalYamlText = read('plugins/mesh-approval/plugin.yaml')
  if (approvalYamlText === null) missing.push('plugins/mesh-approval/plugin.yaml')
  const approvalChangelogText = read('plugins/mesh-approval/CHANGELOG.md')
  if (approvalChangelogText === null) missing.push('plugins/mesh-approval/CHANGELOG.md')

  if (missing.length) {
    const report = { missing, ok: false }
    if (options.json) console.log(JSON.stringify(report, null, 2))
    else for (const file of missing) console.log(`MISSING: ${file}`)
    process.exit(1)
  }

  const hubVersion = /HUB_VERSION\s*=\s*'([^']+)'/.exec(serverText)[1]
  const hubPackage = JSON.parse(hubPackageText).version
  const hubChangelog = changelogVersions(hubChangelogText)
  const wakerPackage = JSON.parse(wakerPackageText).version
  const wakerChangelog = changelogVersions(wakerChangelogText)
  const approvalMatch = /^version:\s*(\d+\.\d+\.\d+)/m.exec(approvalYamlText)
  const approvalVersion = approvalMatch ? approvalMatch[1] : null
  const approvalChangelog = changelogVersions(approvalChangelogText)

  const hubOk = hubVersion === hubPackage && hubVersion === hubChangelog.latest
  const wakerExact = wakerPackage === wakerChangelog.latest
  const wakerUnreleasedAhead =
    wakerChangelog.unreleased && wakerChangelog.latest && compareSemver(wakerPackage, wakerChangelog.latest) > 0
  const wakerOk = Boolean(wakerExact || wakerUnreleasedAhead)
  const approvalOk = approvalVersion === null || approvalVersion === approvalChangelog.latest

  const report = {
    hub: { server: hubVersion, package: hubPackage, changelog: hubChangelog.latest, ok: hubOk },
    waker: {
      package: wakerPackage,
      changelog: wakerChangelog.latest,
      unreleased: wakerChangelog.unreleased,
      unreleasedAhead: Boolean(wakerUnreleasedAhead),
      ok: wakerOk,
    },
    approval: {
      pluginYaml: approvalVersion,
      changelog: approvalChangelog.latest,
      skipped: approvalVersion === null,
      ok: approvalOk,
    },
    ok: Boolean(hubOk && wakerOk && approvalOk),
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`hub      ${hubOk ? 'OK  ' : 'FAIL'} HUB_VERSION=${hubVersion} package=${hubPackage} CHANGELOG=${hubChangelog.latest}`)
    console.log(
      `waker    ${wakerOk ? 'OK  ' : 'FAIL'} package=${wakerPackage} CHANGELOG=${wakerChangelog.latest}` +
        (wakerUnreleasedAhead ? `（未发布 领先：${wakerPackage} > ${wakerChangelog.latest}）` : ''),
    )
    console.log(
      `approval ${approvalOk ? 'OK  ' : 'FAIL'} ` +
        (approvalVersion === null ? 'plugin.yaml 无版本，已跳过' : `plugin.yaml=${approvalVersion} CHANGELOG=${approvalChangelog.latest}`),
    )
  }
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
