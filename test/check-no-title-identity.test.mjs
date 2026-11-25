/**
 * Tests for scripts/check-no-title-identity.mjs (T-mwwfvvzw).
 *
 * The gate's first version was a false green: a whole-file allowlist meant `index.js` — which
 * holds two real title→identity uses — was never scanned, and the "marker anywhere in the
 * enclosing function" rule let one `fallback` comment excuse a 300-line function. These cases
 * exist so that regression can never again be invisible: every shape the coordinator injected
 * by hand is a fixture here.
 *
 * Every case runs the real gate as a child process against a throwaway tree, so what is tested
 * is the shipped binary, not a re-implementation of its rules.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = path.join(import.meta.dirname, '..')
const GATE = path.join(REPO, 'scripts', 'check-no-title-identity.mjs')

/** Build a throwaway repo-shaped tree and return its root. */
function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-gate-'))
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }
  return root
}

/** Run the real gate against `root`; returns { code, json }. */
function runGate(root) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, '--json', '--root', root], { cwd: REPO, encoding: 'utf8' })
    return { code: 0, json: JSON.parse(stdout) }
  } catch (error) {
    let json = null
    try {
      json = JSON.parse(String(error.stdout ?? ''))
    } catch {
      json = null
    }
    return { code: error.status ?? 1, json }
  }
}

function withTree(files, fn) {
  const root = makeTree(files)
  try {
    return fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const PLUGIN = 'plugins/mesh-waker'

test('gate: defining a classifier is allowed', () => {
  withTree(
    {
      [`${PLUGIN}/lib/session.mjs`]: [
        'export function isCoordinatorTitle(title) {',
        "  return /·\\s*(协调|coordinator)\\s*$/.test(String(title ?? ''))",
        '}',
        'export function classifyRoleCandidates(titles) {',
        '  return { roles: titles, unrecognized: [] }',
        '}',
        '',
      ].join('\n'),
      [`${PLUGIN}/index.js`]: ["export { isCoordinatorTitle, classifyRoleCandidates } from './lib/session.mjs'", ''].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 0, `definitions must not be flagged: ${JSON.stringify(result.json?.issues)}`)
      assert.equal(result.json?.ok, true)
      // Two declaration lines. The `export { a, b } from ...` line is not counted: the names
      // carry no call parens, so it is never mistaken for a use in the first place.
      assert.match(String(result.json?.definitions), /^2 /, 'two function declarations')
      assert.equal(result.json?.issues?.length, 0)
      assert.equal(result.json?.markedUses, '0 marked uses')
    },
  )
})

test('gate: calling a classifier inside a function body with no marker is red', () => {
  withTree(
    {
      [`${PLUGIN}/lib/session.mjs`]: ['export function isCoordinatorTitle(title) {', '  return Boolean(title)', '}', ''].join('\n'),
      [`${PLUGIN}/use.mjs`]: [
        'import { isCoordinatorTitle } from "./lib/session.mjs"',
        '',
        'export function pickRequesterByTitle(sessions) {',
        '  const match = sessions.find((session) => isCoordinatorTitle(session.title))',
        '  return match ? match.id : null',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'an unexplained use must fail the gate')
      const issue = result.json?.issues?.find((entry) => entry.file === `${PLUGIN}/use.mjs`)
      assert.ok(issue, `expected a use.mjs hit, saw ${JSON.stringify(result.json?.issues)}`)
      assert.equal(issue.line, 4)
      assert.equal(issue.call, 'isCoordinatorTitle')
    },
  )
})

test('gate: the same call with a nearby marker passes', () => {
  withTree(
    {
      [`${PLUGIN}/lib/session.mjs`]: ['export function isCoordinatorTitle(title) {', '  return Boolean(title)', '}', ''].join('\n'),
      [`${PLUGIN}/use.mjs`]: [
        'import { isCoordinatorTitle } from "./lib/session.mjs"',
        '',
        'export function pickRequesterByTitle(sessions) {',
        '  // title-identity-allowed: display — reporting only, never routing',
        '  const match = sessions.find((session) => isCoordinatorTitle(session.title))',
        '  return match ? match.id : null',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 0, `a marked use must pass: ${JSON.stringify(result.json?.issues)}`)
      assert.equal(result.json?.markedUses, '1 marked uses')
    },
  )
})

test('gate: a marker on the call line itself also passes', () => {
  withTree(
    {
      [`${PLUGIN}/use.mjs`]: [
        'export function probe(sessions) {',
        '  return sessions.filter((s) => isCoordinatorTitle(s.title)) // title-identity-allowed: accounting — counted only',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 0, JSON.stringify(result.json?.issues))
    },
  )
})

test('gate: an empty marker reason does not count as a marker', () => {
  withTree(
    {
      [`${PLUGIN}/use.mjs`]: ['export function probe(sessions) {', '  // title-identity-allowed:', '  return isCoordinatorTitle(sessions[0].title)', '}', ''].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'a marker with no reason is not a justification')
      assert.equal(result.json?.issues?.length, 1)
    },
  )
})

test('gate: a distant `fallback` in the same function does not excuse the call', () => {
  // The v1 rule scanned the whole enclosing function body, so one comment anywhere in a long
  // function waved every title call through. This is that regression, pinned.
  const filler = Array.from({ length: 30 }, (_, index) => `  // filler line ${index}`)
  withTree(
    {
      [`${PLUGIN}/use.mjs`]: [
        'export function bigPolicy(sessions) {',
        '  // this branch is a fallback for when the registry is empty',
        ...filler,
        '  const picked = sessions.find((session) => isCoordinatorTitle(session.title))',
        '  return picked ?? null',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'proximity is the rule, not "somewhere in this function"')
      const issue = result.json?.issues?.[0]
      assert.ok(issue)
      assert.equal(issue.call, 'isCoordinatorTitle')
    },
  )
})

test('gate: no whole-file exemption can hide a real use', () => {
  // v1 allowlisted plugins/mesh-waker/index.js, so this exact shape was invisible.
  withTree(
    {
      [`${PLUGIN}/index.js`]: [
        'const derived = classifyRoleCandidates([session.title]).roles[0] ?? null',
        'export { isCoordinatorTitle } from "./lib/session.mjs"',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'index.js must be scanned like any other file')
      assert.equal(result.json?.issues?.length, 1)
      assert.equal(result.json?.issues?.[0].line, 1)
    },
  )
})

test('gate: the three injected shapes from the review all fail', () => {
  // Verbatim shapes from the coordinator's report (T-mwwfvvzw): top level, function body,
  // class method. All three were MISSED by v1.
  const cases = [
    ['top level', "const probeTop = isCoordinatorTitle('x')", 'isCoordinatorTitle'],
    ['function body', "function probeFn() { return isCoordinatorTitle('x') }", 'isCoordinatorTitle'],
    ['class method', "class Probe { probe() { return classifyRoleCandidates(['a']).roles[0] } }", 'classifyRoleCandidates'],
  ]
  for (const [label, line, call] of cases) {
    withTree({ [`${PLUGIN}/probe.mjs`]: `${line}\n` }, (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, `${label} must be caught`)
      assert.equal(result.json?.issues?.[0]?.call, call, `${label} must name the classifier`)
      assert.equal(result.json?.issues?.[0]?.line, 1, `${label} must report the line`)
    })
  }
})

test('gate: a drifted marker line is red, not silently tolerated', () => {
  // Insert a line ABOVE the marker so the marker no longer sits on the call line or the one
  // directly above it. Line-scoped means drift is visible.
  withTree(
    {
      [`${PLUGIN}/use.mjs`]: [
        'export function probe(sessions) {',
        '  // title-identity-allowed: display — reporting only',
        '  const spacer = 1',
        '  return isCoordinatorTitle(sessions[0].title)',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 1, 'a marker two lines above must not count')
      assert.equal(result.json?.issues?.[0]?.line, 4)
    },
  )
})

test('gate: comments mentioning a classifier are not uses', () => {
  withTree(
    {
      [`${PLUGIN}/notes.mjs`]: [
        '// isCoordinatorTitle( is the old way of picking a coordinator',
        '/*',
        ' * classifyRoleCandidates( must never decide identity',
        ' */',
        'export const NOTE = 1',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = runGate(root)
      assert.equal(result.code, 0, JSON.stringify(result.json?.issues))
      assert.equal(result.json?.issues?.length, 0)
    },
  )
})

test('gate: the shipped tree is clean and every use is justified', () => {
  // The real plugin tree, as committed. 5 uses are expected to carry markers and 3 declaration
  // sites are expected to be recognised; if someone adds a use without a reason, this fails.
  const result = (() => {
    try {
      const stdout = execFileSync(process.execPath, [GATE, '--json'], { cwd: REPO, encoding: 'utf8' })
      return { code: 0, json: JSON.parse(stdout) }
    } catch (error) {
      return { code: error.status ?? 1, json: JSON.parse(String(error.stdout ?? '{}')) }
    }
  })()
  assert.equal(result.code, 0, `the real tree must be clean: ${JSON.stringify(result.json?.issues)}`)
  assert.equal(result.json?.unexplainedUses, '0 unexplained uses')
  assert.equal(result.json?.markedUses, '5 marked uses', 'exactly the five reviewed uses carry a reason')
  assert.equal(result.json?.definitions, '3 declarations/exports')
})
