import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'init-project.mjs')

function tempRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'init-project-'))
  execFileSync('git', ['init', '-q', dir])
  return dir
}

function run(dir, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--name', 'demo', '--roles', 'hub,docs', ...extra], {
    encoding: 'utf8',
  })
}

function read(dir, rel) {
  return readFileSync(path.join(dir, rel), 'utf8')
}

test('scaffolds a fresh git repository', () => {
  const dir = tempRepo()
  const result = run(dir)
  assert.equal(result.status, 0, result.stderr)

  for (const rel of [
    'AGENTS.md',
    '.gitignore',
    '.worklog/WORKLOG.md',
    '.worklog/gates.json',
    '.worklog/dispatch/queue.md',
    '.worklog/todo/hub.md',
    '.worklog/todo/docs.md',
    '.worklog/bin/roadmap.mjs',
    '.worklog/bin/defects.mjs',
    '.worklog/bin/dispatch.mjs',
  ]) {
    assert.ok(existsSync(path.join(dir, rel)), `missing ${rel}`)
  }

  const agents = read(dir, 'AGENTS.md')
  assert.match(agents, /demo/)
  assert.match(agents, /hub \/ docs/)
  assert.doesNotMatch(agents, /<项目名>/)

  const gates = JSON.parse(read(dir, '.worklog/gates.json'))
  assert.deepEqual(gates.gates, [])

  const gitignoreLines = read(dir, '.gitignore').split(/\r?\n/).filter((line) => line.trim() === '.worklog/')
  assert.equal(gitignoreLines.length, 1)

  assert.match(result.stdout, /created/)
})

test('second run changes nothing and reports skipped', () => {
  const dir = tempRepo()
  assert.equal(run(dir).status, 0)
  const before = new Map(
    ['AGENTS.md', '.worklog/WORKLOG.md', '.worklog/todo/hub.md', '.worklog/gates.json'].map((rel) => [
      rel,
      read(dir, rel),
    ]),
  )
  const second = run(dir)
  assert.equal(second.status, 0, second.stderr)
  assert.doesNotMatch(second.stdout, /created /, second.stdout)
  assert.match(second.stdout, /skipped/)
  for (const [rel, content] of before) assert.equal(read(dir, rel), content, `${rel} changed`)
})

test('refuses a directory without .git unless --force is given', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'init-project-nogit-'))
  const result = run(dir)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /not a git repository/)
  assert.match(result.stderr, /git init/)
  assert.ok(!existsSync(path.join(dir, '.worklog')))

  const forced = run(dir, ['--force'])
  assert.equal(forced.status, 0, forced.stderr)
  assert.ok(existsSync(path.join(dir, '.worklog', 'gates.json')))
})

test('does not duplicate an existing .worklog/ ignore line', () => {
  const dir = tempRepo()
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.worklog/\n', 'utf8')
  const result = run(dir)
  assert.equal(result.status, 0, result.stderr)
  const lines = read(dir, '.gitignore').split(/\r?\n/).filter((line) => line.trim() === '.worklog/')
  assert.equal(lines.length, 1)
})

test('dry run writes nothing', () => {
  const dir = tempRepo()
  const result = run(dir, ['--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /plan dir/)
  assert.ok(!existsSync(path.join(dir, '.worklog')))
})

const REPO_SKILL_SCRIPTS = path.join(ROOT, 'skills', 'worklog', 'scripts')
const REPO_DISPATCH = path.join(ROOT, 'scripts', 'mesh-dispatch.mjs')
const skillAvailable = existsSync(path.join(REPO_SKILL_SCRIPTS, 'roadmap.mjs'))

function runNode(dir, script, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(dir, script), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, WORKLOG_SCRIPTS: REPO_SKILL_SCRIPTS, MESH_DISPATCH_SCRIPT: REPO_DISPATCH, ...env },
  })
}

test(
  'e2e: scaffolded project runs roadmap --write',
  { skip: skillAvailable ? false : 'worklog skill not available in this checkout' },
  () => {
    const dir = tempRepo()
    assert.equal(run(dir).status, 0)
    const result = runNode(dir, '.worklog/bin/roadmap.mjs', ['--write'])
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
    assert.match(result.stdout, /wrote ROADMAP/)
    const roadmap = read(dir, 'ROADMAP.md')
    assert.match(roadmap, /AUTO:TODO START/)
    assert.match(roadmap, /AUTO:TODO END/)
    const check = runNode(dir, '.worklog/bin/roadmap.mjs', ['--check'])
    assert.equal(check.status, 0, `${check.stderr}\n${check.stdout}`)
  },
)

test(
  'e2e: generated forwarders run their implementations',
  { skip: skillAvailable ? false : 'worklog skill not available in this checkout' },
  () => {
    const dir = tempRepo()
    assert.equal(run(dir).status, 0)
    for (const [script, args] of [
      ['defects.mjs', ['--help']],
      ['dispatch.mjs', ['--help']],
    ]) {
      const result = runNode(dir, `.worklog/bin/${script}`, args)
      assert.equal(result.status, 0, `${script}: ${result.stderr}\n${result.stdout}`)
    }
  },
)

test(
  'e2e: forwarder reports a clear error when the implementation is missing',
  { skip: skillAvailable ? false : 'worklog skill not available in this checkout' },
  () => {
    const dir = tempRepo()
    assert.equal(run(dir).status, 0)
    const result = spawnSync(process.execPath, [path.join(dir, '.worklog/bin/roadmap.mjs'), '--check'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, WORKLOG_SCRIPTS: path.join(dir, 'nowhere'), HOME: dir, USERPROFILE: dir },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /not found/)
    assert.match(result.stderr, /looked for:/)
  },
)
