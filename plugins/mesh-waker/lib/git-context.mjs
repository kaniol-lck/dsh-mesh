import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const GIT_TIMEOUT_MS = 3000
const MAX_ARTIFACTS = 10

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/**
 * A git snapshot of the directory a task will run in (T-416). Never throws: a missing git
 * binary, a non-repo directory or a hung fs just means "no git information", which must not
 * fail a dispatch.
 */
export function readGitContext(cwd) {
  const dir = String(cwd ?? '').trim()
  if (!dir) return null
  try {
    const branch = runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const head = runGit(dir, ['rev-parse', '--short', 'HEAD'])
    const dirty = runGit(dir, ['status', '--porcelain']).length > 0
    return { cwd: dir, branch, head, dirty }
  } catch {
    return null
  }
}

/**
 * Validate the `artifacts` argument: paths are relative to the target cwd, at most 10, and may
 * not be absolute or climb out of the workspace. Throws with a caller-facing message otherwise.
 */
export function normalizeArtifacts(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('artifacts must be an array of relative paths')
  if (value.length > MAX_ARTIFACTS) throw new Error(`artifacts accepts at most ${MAX_ARTIFACTS} paths`)
  const normalized = []
  for (const raw of value) {
    const path = String(raw ?? '').trim()
    if (!path) throw new Error('artifacts entries must be non-empty paths')
    if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
      throw new Error(`artifacts entry "${path}" must be relative to the target workspace, not absolute`)
    }
    const segments = path.split(/[\\/]+/)
    if (segments.includes('..')) throw new Error(`artifacts entry "${path}" must not contain ..`)
    normalized.push(path)
  }
  return normalized
}

/** Describe declared artifacts at settlement: missing ones are listed too (exists:false). */
export function describeArtifacts(cwd, artifacts) {
  const dir = String(cwd ?? '').trim()
  const list = Array.isArray(artifacts) ? artifacts : []
  if (!list.length) return null
  return list.map((path) => {
    const target = resolve(dir || '.', path)
    try {
      const stat = statSync(target)
      return { path, exists: true, sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
    } catch {
      return { path, exists: false, sizeBytes: null, mtimeMs: null }
    }
  })
}
