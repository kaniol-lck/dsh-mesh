#!/usr/bin/env node
/**
 * check-config-docs.mjs — standing invariant: every configuration key in code is documented.
 *
 * Sources:
 *   waker keys  plugins/mesh-waker/index.js   `c.<key>` (incl. nested `c.a?.b`)
 *   hub env     hub/server.mjs                `process.env.MESH_*`
 * Docs:
 *   waker       plugins/mesh-waker/README.md  config table rows `| `key` |`
 *   hub         hub/README.md + hub/.env.example
 *
 * Exit 0 when documented, 1 when keys are missing. `--json` for machine use.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// JS builtins that look like config reads but are not configuration.
// constructor/length/apply are properties of every object/function; Promise and
// array helpers appear when `c` is a callback argument rather than the config object.
const IGNORED = new Set([
  'constructor', 'length', 'apply', 'call', 'bind', 'prototype', 'name',
  'toString', 'valueOf', 'hasOwnProperty', 'then', 'catch', 'finally',
  'push', 'pop', 'map', 'filter', 'forEach', 'slice', 'includes', 'split',
  'replace', 'trim', 'toLowerCase', 'toUpperCase', 'join', 'concat', 'startsWith', 'endsWith',
])

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

function extractWakerKeys() {
  const source = read('plugins/mesh-waker/index.js')
  const keys = new Set()
  for (const match of source.matchAll(/\bc\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1])
  return [...keys].filter((key) => !IGNORED.has(key)).sort()
}

function extractHubEnvKeys() {
  const source = read('hub/server.mjs')
  return [...new Set([...source.matchAll(/process\.env\.(MESH_[A-Z0-9_]+)/g)].map((match) => match[1]))].sort()
}

function documentedWakerKeys() {
  const readme = read('plugins/mesh-waker/README.md')
  return new Set([...readme.matchAll(/^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm)].map((match) => match[1]))
}

function documentedHubKeys() {
  const text = read('hub/README.md') + '\n' + read('hub/.env.example')
  return new Set([...text.matchAll(/MESH_[A-Z0-9_]+/g)].map((match) => match[0]))
}

function main() {
  const json = process.argv.includes('--json')
  const wakerCode = extractWakerKeys()
  const hubCode = extractHubEnvKeys()
  const wakerDocs = documentedWakerKeys()
  const hubDocs = documentedHubKeys()
  const wakerMissing = wakerCode.filter((key) => !wakerDocs.has(key))
  const hubMissing = hubCode.filter((key) => !hubDocs.has(key))
  const missing = wakerMissing.length + hubMissing.length

  if (json) {
    console.log(JSON.stringify({ waker: { code: wakerCode.length, documented: wakerDocs.size, missing: wakerMissing }, hub: { code: hubCode.length, documented: hubDocs.size, missing: hubMissing }, missing }, null, 2))
  } else {
    console.log(`waker 配置键：代码 ${wakerCode.length} / 文档 ${wakerDocs.size} / 缺失 ${wakerMissing.length}`)
    for (const key of wakerMissing.slice(0, 40)) console.log(`  MISSING waker.${key}`)
    if (wakerMissing.length > 40) console.log(`  … 其余 ${wakerMissing.length - 40} 个`)
    console.log(`hub env：代码 ${hubCode.length} / 文档 ${hubDocs.size} / 缺失 ${hubMissing.length}`)
    for (const key of hubMissing.slice(0, 40)) console.log(`  MISSING ${key}`)
    if (hubMissing.length > 40) console.log(`  … 其余 ${hubMissing.length - 40} 个`)
    if (!missing) console.log('OK 配置键全部有文档')
  }
  process.exit(missing ? 1 : 0)
}

main()
