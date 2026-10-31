#!/usr/bin/env node
/**
 * check-config-usage.mjs — standing invariant: a parsed config key must be used.
 *
 * check-config-docs only proves "code has it, docs mention it". This is the other
 * direction: a key can be parsed into the config object and never referenced again
 * (the README then documents behaviour that does not exist).
 *
 * Declaration = a line that reads `c.<key>` (or `c.parent?.<key>`) and stores it
 * under <key> in the config object, including multi-line objects such as
 * permissionPresetByTrust. References = every other `.<key>` occurrence in the file.
 * A key whose only occurrence is the declaration line is DEAD.
 *
 * Scope: waker only. hub env vars are not covered yet (reported as hubCovered:false).
 *
 * Exit codes: 0 no dead keys, 1 at least one DEAD. `--json` for machine use.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Keys that legitimately have no second reference. Each entry needs a reason:
//   - display-only values are read through the whole config object by the UI;
//   - dynamically composed names are matched at runtime, not as `.key`.
const EXCLUDED = new Map([
  ['agentPreset', 'read by the host from the whole config object (display/permission preset name)'],
  ['workspaceTitle', 'read by the host workspace UI, not referenced in this file'],
  ['sessionTitle', 'passed to the host session factory as part of the whole config'],
  ['logMaxBytes', 'consumed by configureLog(c.logFile, c.logMaxBytes) and the rotateLog helper'],
])

function parseArgs(argv) {
  const options = {
    index: path.join(ROOT, 'plugins/mesh-waker/index.js'),
    readme: path.join(ROOT, 'plugins/mesh-waker/README.md'),
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) {
        console.error(`${arg} requires a value`)
        process.exit(2)
      }
      index += 1
      return next
    }
    switch (arg) {
      case '--index': options.index = value(); break
      case '--readme': options.readme = value(); break
      case '--json': options.json = true; break
      case '-h':
      case '--help':
        console.log('check-config-usage.mjs [--index <file>] [--readme <file>] [--json]')
        process.exit(0)
        break
      default:
        console.error(`unknown argument: ${arg}`)
        process.exit(2)
    }
  }
  return options
}

/** Declarations: `<key>: … .<key>` on one line, or `<key>: {` whose block reads `c.<key>`. */
export function configRegion(lines) {
  const start = lines.findIndex((line) => /^function normalizeBase\b/.test(line.trim()))
  if (start < 0) return { start: 0, end: lines.length }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^function\s/.test(lines[index].trim())) {
      end = index
      break
    }
  }
  return { start, end }
}

export function findDeclarations(lines, region = configRegion(lines)) {
  const declarations = new Map()
  for (let index = region.start; index < region.end; index += 1) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[index])
    if (!match) continue
    const key = match[1]
    if (declarations.has(key)) continue
    const window = lines.slice(index, index + 8).join('\n')
    if (!new RegExp(`\\.${key}\\b`).test(window)) continue
    declarations.set(key, index + 1)
  }
  return declarations
}

export function findDeadKeys(lines, excluded = EXCLUDED, region = configRegion(lines)) {
  const declarations = findDeclarations(lines, region)
  const dead = []
  for (const [key, line] of declarations) {
    if (excluded.has(key)) continue
    const pattern = new RegExp(`\\.${key}\\b`, 'g')
    let references = 0
    for (let index = 0; index < lines.length; index += 1) {
      if (index + 1 === line) continue
      references += (lines[index].match(pattern) ?? []).length
    }
    if (references === 0) dead.push({ key, line })
  }
  return { code: declarations.size, dead }
}

function readmeTableKeys(readme) {
  return new Set([...readme.matchAll(/^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm)].map((match) => match[1]))
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const lines = readFileSync(options.index, 'utf8').split(/\r?\n/)
  const readmeKeys = readmeTableKeys(readFileSync(options.readme, 'utf8'))
  const { code, dead } = findDeadKeys(lines)
  const enriched = dead.map((item) => ({ ...item, describedInReadme: readmeKeys.has(item.key) }))

  if (options.json) {
    console.log(JSON.stringify({ code, dead: enriched, excluded: [...EXCLUDED.keys()], hubCovered: false }, null, 2))
  } else {
    console.log(`waker 配置键 ${code}：DEAD ${enriched.length}`)
    for (const item of enriched) {
      const described = item.describedInReadme ? 'README 有描述' : 'README 未描述'
      console.log(`DEAD ${item.key} —— 只在 ${path.basename(options.index)}:${item.line} 声明，${described} 但代码未使用`)
    }
    if (!enriched.length) console.log('OK 所有声明过的配置键都有引用')
    console.log('注：hub 的 process.env.* 暂未纳入本检查（hubCovered=false）')
  }
  process.exit(enriched.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
