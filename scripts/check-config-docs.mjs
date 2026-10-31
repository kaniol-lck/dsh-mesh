#!/usr/bin/env node
/**
 * check-config-docs.mjs — standing invariant: configuration keys are documented.
 *
 * Two levels, deliberately different in severity:
 *   MISSING      the key appears nowhere in the doc corpus -> a real gap, exit 1
 *   NOT-IN-TABLE the key appears in prose/docs but not as a row of the waker
 *                README config table -> table completeness only, WARN, exit unchanged
 *
 * Corpus: plugins/mesh-waker/README.md + docs/*.md + skills/mesh/SKILL.md.
 * Whether a key has a *behavioural explanation* is not machine-decidable; that
 * stays a human review item (a bare string mention must not count as documented).
 *
 * Exit codes: 0 no MISSING, 1 at least one MISSING. `--json` for machine use.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// JS builtins that match `c.<name>` but are never configuration:
//   every object/function has constructor/length/apply/call/bind/prototype/name/toString/...
//   Promise results expose then/catch/finally; strings and arrays expose the rest.
// They appear because `c` is also used as a local variable name for callbacks.
const IGNORED = new Set([
  'constructor', 'length', 'apply', 'call', 'bind', 'prototype', 'name',
  'toString', 'valueOf', 'hasOwnProperty', 'then', 'catch', 'finally',
  'push', 'pop', 'map', 'filter', 'forEach', 'slice', 'includes', 'split',
  'replace', 'trim', 'toLowerCase', 'toUpperCase', 'join', 'concat', 'startsWith', 'endsWith',
])

export function extractWakerKeys(source) {
  const keys = new Set()
  for (const match of source.matchAll(/\bc\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(match[1])
  // nested access such as c.approvalBridge?.to: count the parent and the child
  for (const match of source.matchAll(/\bc\.([A-Za-z_][A-Za-z0-9_]*)\??\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    keys.add(match[1])
    keys.add(match[2])
  }
  return [...keys].filter((key) => !IGNORED.has(key)).sort()
}

export function tableKeysOf(readme) {
  return new Set([...readme.matchAll(/^\|\s*`([A-Za-z_][A-Za-z0-9_]*)`\s*\|/gm)].map((match) => match[1]))
}

/** Pure classifier so tests can feed synthetic corpus/table without touching the repo. */
export function classifyKeys(codeKeys, corpusText, tableKeys) {
  const appears = (key) => new RegExp(`\\b${key}\\b`).test(corpusText)
  const missing = codeKeys.filter((key) => !appears(key))
  const notInTable = codeKeys.filter((key) => appears(key) && !tableKeys.has(key))
  return { missing, notInTable }
}

function readCorpus() {
  const parts = [readFileSync(path.join(ROOT, 'plugins/mesh-waker/README.md'), 'utf8')]
  for (const file of readdirSync(path.join(ROOT, 'docs')).filter((name) => name.endsWith('.md')).sort()) {
    parts.push(readFileSync(path.join(ROOT, 'docs', file), 'utf8'))
  }
  parts.push(readFileSync(path.join(ROOT, 'skills/mesh/SKILL.md'), 'utf8'))
  return parts.join('\n')
}

function documentedHubKeys() {
  const text = readFileSync(path.join(ROOT, 'hub/README.md'), 'utf8') + '\n' + readFileSync(path.join(ROOT, 'hub/.env.example'), 'utf8')
  return new Set([...text.matchAll(/MESH_[A-Z0-9_]+/g)].map((match) => match[0]))
}

function main() {
  const json = process.argv.includes('--json')
  const wakerSource = readFileSync(path.join(ROOT, 'plugins/mesh-waker/index.js'), 'utf8')
  const readme = readFileSync(path.join(ROOT, 'plugins/mesh-waker/README.md'), 'utf8')
  const wakerCode = extractWakerKeys(wakerSource)
  const tableKeys = tableKeysOf(readme)
  const { missing, notInTable } = classifyKeys(wakerCode, readCorpus(), tableKeys)
  const hubSource = readFileSync(path.join(ROOT, 'hub/server.mjs'), 'utf8')
  const hubCode = [...new Set([...hubSource.matchAll(/process\.env\.(MESH_[A-Z0-9_]+)/g)].map((match) => match[1]))].sort()
  const hubDocs = documentedHubKeys()
  const hubMissing = hubCode.filter((key) => !hubDocs.has(key))

  if (json) {
    console.log(
      JSON.stringify(
        {
          waker: { code: wakerCode.length, missing, notInTable },
          hub: { code: hubCode.length, missing: hubMissing },
          counts: { wakerMissing: missing.length, wakerNotInTable: notInTable.length, hubMissing: hubMissing.length },
        },
        null,
        2,
      ),
    )
  } else {
    const covered = wakerCode.length - missing.length - notInTable.length
    console.log(`waker 配置键 ${wakerCode.length}：MISSING ${missing.length} / NOT-IN-TABLE ${notInTable.length} / 已覆盖 ${covered}`)
    if (missing.length) console.log(`MISSING（任何文档都没有）：${missing.join(', ')}`)
    if (notInTable.length) console.log(`NOT-IN-TABLE（README 有但配置表没列）：${notInTable.join(', ')}`)
    console.log(`hub env：代码 ${hubCode.length} / 文档 ${hubDocs.size} / 缺失 ${hubMissing.length}`)
    for (const key of hubMissing) console.log(`  MISSING ${key}`)
  }
  process.exit(missing.length + hubMissing.length ? 1 : 0)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
