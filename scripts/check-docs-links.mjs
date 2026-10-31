#!/usr/bin/env node
/**
 * check-docs-links.mjs — standing invariant: no dead relative links in tracked markdown.
 *
 * Walks `git ls-files '*.md'`, extracts markdown link targets `](target)`, skips
 * http(s)/mailto/anchor/placeholder targets, and checks the rest with existsSync.
 * Exit 0 when clean, 1 on dead links. `--json` for machine use.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LINK = /\]\(([^)]+)\)/g

function main() {
  const json = process.argv.includes('--json')
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  const broken = []
  for (const rel of files) {
    const file = path.join(ROOT, rel)
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    let lineNumber = 0
    for (const line of text.split(/\r?\n/)) {
      lineNumber += 1
      for (const match of line.matchAll(LINK)) {
        const raw = match[1].split('#')[0].trim()
        if (!raw || raw.startsWith('<') || /^(https?:|mailto:|tel:)/.test(raw)) continue
        const target = path.resolve(path.dirname(file), raw)
        if (!existsSync(target)) broken.push({ file: rel, line: lineNumber, target: raw })
      }
    }
  }
  if (json) {
    console.log(JSON.stringify({ files: files.length, broken }, null, 2))
  } else {
    console.log(`检查 ${files.length} 个 markdown 文件，死链 ${broken.length}`)
    for (const item of broken) console.log(`  DEAD ${item.file}:${item.line} -> ${item.target}`)
  }
  process.exit(broken.length ? 1 : 0)
}

main()
