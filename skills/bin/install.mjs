#!/usr/bin/env node
/**
 * dsh-mesh-skills installer — copies the bundled skills into a DSH skills directory.
 *
 * Zero dependencies: only node:fs / node:path / node:os.
 *
 * Usage:
 *   dsh-mesh-skills install [--dest <dir>] [--force] [--dry-run] [--help]
 *
 * Default dest: ~/.dsh/skills. Each skill is copied as <dest>/<skill>/; an existing
 * <dest>/<skill> is skipped unless --force is given. --dry-run prints the plan only.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = ['mesh', 'handoff', 'worklog']
const USAGE = `dsh-mesh-skills — install the bundled DSH skills

Usage:
  dsh-mesh-skills install [options]

Options:
  --dest <dir>   target skills directory (default: ~/.dsh/skills)
  --force        overwrite skills that already exist in the target
  --dry-run      print the plan; write nothing
  -h, --help     print this help and exit

Skills: ${SKILLS.join(', ')}
Each skill is copied to <dest>/<skill>/. Existing directories are skipped and
reported; --force replaces them. This installer never touches ~/.dsh/config or
the dsh profile: it only copies files under the target skills directory.`

function parseArgs(argv) {
  const options = { dest: path.join(os.homedir(), '.dsh', 'skills'), force: false, dryRun: false, help: false }
  let command = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      if (argv[index + 1] === undefined) fail(2, `${arg} requires a value\n\n${USAGE}`)
      index += 1
      return argv[index]
    }
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--force') options.force = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--dest') options.dest = path.resolve(value())
    else if (!arg.startsWith('-') && command === null) command = arg
    else fail(2, `unknown argument: ${arg}\n\n${USAGE}`)
  }
  if (command !== null && command !== 'install') fail(2, `unknown command: ${command} (only "install" is supported)\n\n${USAGE}`)
  return options
}

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (!options.dryRun) mkdirSync(options.dest, { recursive: true })
  const results = []
  for (const skill of SKILLS) {
    const source = path.join(PACKAGE_ROOT, skill)
    const target = path.join(options.dest, skill)
    if (!existsSync(source)) {
      results.push({ skill, action: 'missing-source', target })
      continue
    }
    if (existsSync(target) && !options.force) {
      results.push({ skill, action: 'skipped', target })
      continue
    }
    if (options.dryRun) {
      results.push({ skill, action: existsSync(target) ? 'overwritten' : 'copied', target, dryRun: true })
      continue
    }
    if (existsSync(target)) rmSync(target, { recursive: true, force: true })
    cpSync(source, target, { recursive: true })
    results.push({ skill, action: existsSync(target) ? (options.force ? 'overwritten' : 'copied') : 'copied', target })
  }
  for (const result of results) {
    const suffix = result.dryRun ? ' (dry-run)' : ''
    const note = result.action === 'skipped' ? ' — 已存在，跳过（--force 覆盖）' : ''
    console.log(`${result.action} ${result.skill} -> ${result.target}${note}${suffix}`)
  }
  const summary = results.reduce((counts, result) => {
    counts[result.action] = (counts[result.action] ?? 0) + 1
    return counts
  }, {})
  console.log(`done: ${Object.entries(summary).map(([action, count]) => `${action}=${count}`).join(' ')}`)
  return 0
}

process.exitCode = main()
