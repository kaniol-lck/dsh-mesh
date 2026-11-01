// Task text storage helpers (T-292): content-addressed textRefs, no plugin state.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Read the body of one task row. 0.7.30+ rows store content-addressed text
 * (`textRef: sha256:<hex>`) in the texts directory; older rows may still carry inline
 * `text` or a `textPath`. Missing/legacy references degrade to '' instead of throwing.
 */
export function resolveTaskText(row, textsDir = null) {
  if (!row || typeof row !== 'object') return ''
  const ref = typeof row.textRef === 'string' ? row.textRef : ''
  if (ref) {
    const match = /^sha256:([a-f0-9]{64})$/.exec(ref)
    if (!match || !textsDir) return ''
    try {
      return readFileSync(join(textsDir, `${match[1]}.txt`), 'utf8')
    } catch {
      return ''
    }
  }
  if (typeof row.text === 'string') return row.text
  if (typeof row.textPath === 'string' && row.textPath) {
    try {
      return readFileSync(row.textPath, 'utf8')
    } catch {
      return ''
    }
  }
  return ''
}

export function storeTaskText(textsDir, body) {
  try {
    const hex = createHash('sha256').update(String(body), 'utf8').digest('hex')
    const file = join(textsDir, `${hex}.txt`)
    if (!existsSync(file)) {
      mkdirSync(textsDir, { recursive: true })
      writeFileSync(file, String(body), { mode: 0o600 })
    }
    return `sha256:${hex}`
  } catch {
    return null
  }
}

/**
 * In-place migration of loaded task rows: `text`/`textPath` -> `textRef`, writing each body
 * once into the content-addressed store. Returns `{ migrated, failed }`; callers only rewrite
 * the registry when `failed` is false (a partial failure leaves the file untouched).
 */
export function compactTaskRows(rows, textsDir) {
  let migrated = 0
  for (const row of rows) {
    if (row.textRef) continue
    const legacyPath = typeof row.textPath === 'string' ? row.textPath : null
    if (typeof row.text !== 'string' && !legacyPath) continue
    let body = typeof row.text === 'string' ? row.text : ''
    if (!body && legacyPath) {
      try {
        body = readFileSync(legacyPath, 'utf8')
      } catch {
        body = ''
      }
    }
    if (!body) continue
    const ref = storeTaskText(textsDir, body)
    if (!ref) return { migrated, failed: true, failedAt: row.taskId }
    delete row.text
    delete row.textPath
    row.textRef = ref
    migrated += 1
  }
  return { migrated, failed: false }
}
