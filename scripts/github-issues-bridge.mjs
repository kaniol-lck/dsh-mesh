#!/usr/bin/env node
/**
 * Poll GitHub issues and forward a *summary* of each new issue into a mesh inbox.
 *
 *   node scripts/github-issues-bridge.mjs --repo <owner>/<repo> --hub http://<hub>:8790 \
 *     --token-file ~/.dsh/mesh-token [--conversation issues/<owner>/<repo>] \
 *     [--label needs-triage] [--state-file ...] [--interval 600] [--once] \
 *     [--max-body-chars 400] [--dry-run] [--to <agent>]
 *
 * Only GET requests go to GitHub; the bridge never comments, labels or closes anything.
 * The token file is read locally (never from argv). Without GITHUB_TOKEN the public API
 * is used anonymously (60 requests/hour).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULT_API = 'https://api.github.com'
const MAX_BACKOFF_MS = 5 * 60_000
const RETRIES = 3
const USER_AGENT = 'dsh-mesh-issues-bridge'

function usage() {
  return `usage: node scripts/github-issues-bridge.mjs --repo <owner/repo> --hub <url> --token-file <path>
       [--conversation issues/<owner>/<repo>] [--label needs-triage] [--state-file <path>]
       [--interval 600] [--once] [--max-body-chars 400] [--dry-run] [--to <agent>]
       [--github-api https://api.github.com]

GitHub credentials are resolved in this order (never from argv):
  1. GITHUB_TOKEN or GH_TOKEN environment variable
  2. 'gh auth token' (the gh CLI, already logged in)
  3. anonymous: 60 requests/hour (authenticated: 5000/hour)
A rate-limit response (429/403) backs off exponentially, up to 5 minutes.
The bridge only issues GET requests to GitHub; it never comments, labels or closes issues.`
}

function fail(message) {
  console.error(`[issues] ${message}`)
  process.exit(2)
}

export function parseArgs(argv) {
  const options = {
    repo: null,
    hub: null,
    tokenFile: null,
    conversation: null,
    label: null,
    stateFile: null,
    interval: 600,
    once: false,
    maxBodyChars: 400,
    dryRun: false,
    to: process.env.MESH_ISSUES_TO || 'triage',
    githubApi: process.env.GITHUB_API || DEFAULT_API,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]
    const [flag, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[++index]
      if (next === undefined) fail(`${flag} needs a value`)
      return next
    }
    if (flag === '--repo') options.repo = value()
    else if (flag === '--hub') options.hub = value()
    else if (flag === '--token-file') options.tokenFile = value()
    else if (flag === '--conversation') options.conversation = value()
    else if (flag === '--label') options.label = value()
    else if (flag === '--state-file') options.stateFile = value()
    else if (flag === '--interval') options.interval = Number(value())
    else if (flag === '--max-body-chars') options.maxBodyChars = Number(value())
    else if (flag === '--to') options.to = value()
    else if (flag === '--github-api') options.githubApi = value()
    else if (flag === '--once') options.once = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--help' || flag === '-h') options.help = true
    else fail(`unknown option: ${raw}`)
  }
  if (options.help) return options
  if (!options.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) fail('--repo must look like <owner>/<repo>')
  if (!options.hub || !/^https?:\/\//.test(options.hub)) fail('--hub must be an http(s) URL')
  if (!options.tokenFile) fail('--token-file is required')
  if (!Number.isFinite(options.interval) || options.interval < 30) fail('--interval must be >= 30 seconds')
  if (!Number.isInteger(options.maxBodyChars) || options.maxBodyChars < 50) fail('--max-body-chars must be an integer >= 50')
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(options.to)) fail('--to must be an agent name')
  options.hub = options.hub.replace(/\/+$/, '')
  options.githubApi = options.githubApi.replace(/\/+$/, '')
  options.conversation = options.conversation || `issues/${options.repo}`
  options.stateFile = options.stateFile || join(homedir(), '.dsh', 'mesh-issues', `${options.repo.replace('/', '__')}.json`)
  return options
}

/** GitHub issue bodies often start with a fenced log; keep the prose only. */
export function stripCodeBlocks(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function summarizeIssue(issue, maxBodyChars = 400) {
  const labels = (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean)
  const body = stripCodeBlocks(issue.body).slice(0, maxBodyChars)
  const meta = `#${issue.number} · ${issue.title} · by ${issue.user?.login ?? 'unknown'} · labels[${labels.join(', ')}] · ${issue.html_url}`
  return ['来源=外部未验证（GitHub issue）', meta, '', body].join('\n').trim()
}

export function loadState(stateFile) {
  if (!existsSync(stateFile)) return { repo: null, last_seen_updated_at: null, seen: {}, etag: null }
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    return {
      repo: parsed.repo ?? null,
      last_seen_updated_at: parsed.last_seen_updated_at ?? null,
      seen: parsed.seen && typeof parsed.seen === 'object' ? parsed.seen : {},
      etag: parsed.etag ?? null,
    }
  } catch (error) {
    throw new Error(`state file is corrupt (${stateFile}): ${error.message}`)
  }
}

export function saveState(stateFile, state) {
  mkdirSync(dirname(stateFile), { recursive: true })
  const tmp = `${stateFile}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, stateFile)
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolve GitHub credentials: env, then the gh CLI (no shell interpolation), then
 * anonymous. Failure of any step silently falls through; the token is never logged.
 */
export async function resolveGithubAuth({ env = process.env, execFileImpl = execFile } = {}) {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN
  if (fromEnv && String(fromEnv).trim()) return { token: String(fromEnv).trim(), source: 'env' }
  const token = await new Promise((resolve) => {
    try {
      execFileImpl('gh', ['auth', 'token'], { timeout: 5000 }, (error, stdout) => {
        resolve(error ? null : String(stdout ?? '').trim() || null)
      })
    } catch {
      resolve(null)
    }
  })
  if (token) return { token, source: 'gh-cli' }
  return { token: null, source: 'anonymous' }
}

export function authLogLine(auth) {
  return `github auth: ${auth.source}`
}

async function fetchIssues(options, state, fetchImpl, log) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT }
  if (options.githubToken) headers.authorization = `Bearer ${options.githubToken}`
  if (state.etag) headers['if-none-match'] = state.etag
  const params = new URLSearchParams({ state: 'open', per_page: '50', sort: 'updated', direction: 'asc' })
  if (state.last_seen_updated_at) params.set('since', new Date(state.last_seen_updated_at).toISOString())
  const url = `${options.githubApi}/repos/${options.repo}/issues?${params}`
  let lastError = null
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const response = await fetchImpl(url, { method: 'GET', headers })
    if (response.status === 304) return { issues: [], etag: state.etag, notModified: true }
    if (response.status === 429 || response.status === 403 || response.status >= 500) {
      lastError = new Error(`GitHub HTTP ${response.status}`)
      if (attempt === RETRIES) break
      const delay = Math.min(MAX_BACKOFF_MS, 5000 * 2 ** attempt)
      log(`GitHub HTTP ${response.status}; backing off ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${RETRIES})`)
      await options.sleep(delay)
      continue
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`GitHub HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    const issues = await response.json()
    return { issues: Array.isArray(issues) ? issues : [], etag: response.headers.get('etag') || state.etag, notModified: false }
  }
  throw lastError ?? new Error('GitHub request failed')
}

/**
 * One poll: fetch, filter, send summaries to the hub, persist the watermark.
 * Exported so tests can drive it against local fake servers.
 */
export async function pollIssues(options) {
  const {
    repo, hub, conversation, label = null, stateFile, maxBodyChars = 400, dryRun = false,
    to = 'triage', fetchImpl = globalThis.fetch, log = console.log, sleep = sleepMs,
  } = options
  const state = loadState(stateFile)
  if (state.repo && state.repo !== repo) throw new Error(`state file belongs to ${state.repo}, not ${repo}; use another --state-file`)
  const result = await fetchIssues(
    { ...options, sleep },
    state,
    fetchImpl,
    log,
  )
  if (result.notModified) {
    log('GitHub returned 304 (no changes)')
    return { fetched: 0, sent: 0, skipped: 0 }
  }
  const issues = result.issues.filter((issue) => {
    if (issue.pull_request) return false
    if (issue.state && issue.state !== 'open') return false
    if (issue.user?.type === 'Bot') return false
    if (label && !(issue.labels || []).some((entry) => (typeof entry === 'string' ? entry : entry.name) === label)) return false
    return true
  })
  let sent = 0
  let skipped = 0
  for (const issue of issues) {
    const updatedAt = issue.updated_at ?? issue.created_at
    if (state.seen[String(issue.number)] === updatedAt) {
      skipped += 1
      continue
    }
    const summary = summarizeIssue(issue, maxBodyChars)
    if (dryRun) {
      log(`[dry-run] would send #${issue.number}: ${issue.title}`)
    } else {
      const response = await fetchImpl(`${hub}/api/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.meshToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          to,
          subject: `[issue #${issue.number}] ${String(issue.title).slice(0, 120)}`,
          body: summary,
          conversation,
        }),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`hub POST /api/send failed: HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
      }
    }
    state.seen[String(issue.number)] = updatedAt
    if (!state.last_seen_updated_at || Date.parse(updatedAt) > Date.parse(state.last_seen_updated_at)) {
      state.last_seen_updated_at = updatedAt
    }
    log(`sent #${issue.number} ${issue.title}`)
    sent += 1
    // Persist after every send so a hub failure mid-batch cannot duplicate earlier ones.
    state.repo = repo
    if (!dryRun) saveState(stateFile, state)
  }
  state.repo = repo
  if (result.etag) state.etag = result.etag
  if (!dryRun) saveState(stateFile, state)
  return { fetched: issues.length, sent, skipped }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(usage())
    return 0
  }
  let meshToken
  try {
    meshToken = readFileSync(options.tokenFile, 'utf8').trim()
  } catch (error) {
    console.error(`[issues] cannot read --token-file: ${error.message}`)
    return 1
  }
  if (!meshToken) {
    console.error('[issues] --token-file is empty')
    return 1
  }
  const auth = await resolveGithubAuth()
  console.log(`[issues] ${authLogLine(auth)}`)
  if (auth.source === 'anonymous') {
    console.warn('[issues] anonymous GitHub API (60 req/h); run \'gh auth login\' or set GITHUB_TOKEN')
  }
  const pollOptions = { ...options, meshToken, githubToken: auth.token }
  const kick = async () => {
    try {
      const result = await pollIssues(pollOptions)
      console.log(`[issues] poll: fetched=${result.fetched} sent=${result.sent} skipped=${result.skipped}`)
      return true
    } catch (error) {
      console.error(`[issues] ${error.message}`)
      return false
    }
  }
  if (options.once) return (await kick()) ? 0 : 1
  for (;;) {
    await kick()
    await sleepMs(options.interval * 1000)
  }
}

if (process.argv[1] && process.argv[1].endsWith('github-issues-bridge.mjs')) {
  main().then((code) => { process.exitCode = code })
}
